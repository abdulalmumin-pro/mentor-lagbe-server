import dns from "node:dns";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";


// Fix DNS issue
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const port = process.env.PORT || 5000;

// Better Auth issues the JWTs and exposes its public keys at /api/auth/jwks.
const AUTH_URL = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
).replace(/\/+$/, "");
const jwks = createRemoteJWKSet(new URL(`${AUTH_URL}/api/auth/jwks`));

// Stripe: where to send the user back to after checkout (the Next.js app).
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// PRO price per month in cents, decided by the SERVER from the user's role.
const PRO_PRICE_CENTS = { tutor: 1500, student: 1000 };
const PRO_PRODUCT_NAME = {
  tutor: "MentorLagbe PRO (Tutor)",
  student: "MentorLagbe PRO (Student)",
};

/* -------------------------------------------------------------------------- */
/* App & middleware                                                           */
/* -------------------------------------------------------------------------- */

const app = express();
app.use(
  express.json({
    // Keep the raw body: Stripe webhook signatures are checked against it.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(cors());

/* -------------------------------------------------------------------------- */
/* MongoDB                                                                    */
/* -------------------------------------------------------------------------- */

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.fcqp05s.mongodb.net/`,
);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB Connection Failed:", err);
    throw err;
  }
}

await connectToMongoDB();

const database = client.db("mentor-lagbe-db");
const users = database.collection("user");
const tuitions = database.collection("tuitions");
const applications = database.collection("applications");
const payments = database.collection("payments");

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const text = (value) => (typeof value === "string" ? value.trim() : "");

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  return /^\+?[0-9][0-9\s()-]{5,19}$/.test(value);
}

/** Supports both the older `status: "active"` shape and the `isActive` field. */
function tuitionIsActive(tuition) {
  if (typeof tuition?.isActive === "boolean") return tuition.isActive;
  if (typeof tuition?.status === "string") return tuition.status === "active";
  return true;
}

function serializeTuition(tuition) {
  return {
    ...tuition,
    _id: String(tuition._id),
    isActive: tuitionIsActive(tuition),
  };
}

async function findUser(payload) {
  const filters = [];

  if (payload?.sub) {
    filters.push({ _id: payload.sub });
    if (ObjectId.isValid(payload.sub)) {
      filters.push({ _id: new ObjectId(payload.sub) });
    }
  }
  if (payload?.email) filters.push({ email: payload.email });
  if (filters.length === 0) return null;

  return users.findOne({ $or: filters });
}

/* -------------------------------------------------------------------------- */
/* Auth middleware                                                            */
/* -------------------------------------------------------------------------- */

/** Verifies the Better Auth JWT and loads the current user from MongoDB. */
async function verifyToken(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: AUTH_URL,
      audience: AUTH_URL,
    });

    const dbUser = await findUser(payload);
    req.auth = {
      id: payload.sub,
      email: dbUser?.email || payload.email || "",
      name: dbUser?.name || payload.name || "",
      role: dbUser?.role || payload.role || "",
      plan: dbUser?.plan || payload.plan || "free",
    };

    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

function verifyStudent(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: "Unauthorized" });
  if (req.auth.role !== "student") {
    return res.status(403).json({ error: "Only students can apply." });
  }
  next();
}

/* -------------------------------------------------------------------------- */
/* Route handlers: general                                                    */
/* -------------------------------------------------------------------------- */

const getHome = (req, res) => {
  res.send("Hello World!");
};

const getUsers = async (req, res) => {
  const result = await users.find({}).toArray();
  res.send(result);
};

const getDebugInfo = async (_req, res) => {
  const collections = await database.listCollections().toArray();
  const counts = {};
  for (const c of collections) {
    counts[c.name] = await database.collection(c.name).countDocuments();
  }
  res.json({ database: database.databaseName, collections: counts });
};

/* -------------------------------------------------------------------------- */
/* Route handlers: tuitions                                                   */
/* -------------------------------------------------------------------------- */

const getTuitions = async (req, res) => {
  const result = await tuitions.find().toArray();
  res.send(result.map(serializeTuition));
};

const createTuition = async (req, res) => {
  const tuition = req.body;
  const result = await tuitions.insertOne(tuition);
  res.send(result);
};

const getTuitionById = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid tuition id." });
  }

  const tuition = await tuitions.findOne({ _id: new ObjectId(id) });
  if (!tuition) return res.status(404).json({ error: "Tuition not found." });

  res.json({ tuition: serializeTuition(tuition) });
};

/* -------------------------------------------------------------------------- */
/* Route handlers: applications                                               */
/* -------------------------------------------------------------------------- */

const checkApplication = async (req, res) => {
  const tuitionId = text(req.query.tuitionId);
  if (!ObjectId.isValid(tuitionId)) {
    return res.status(400).json({ error: "Invalid tuition id." });
  }

  const studentEmail = req.auth.email.toLowerCase();
  const application = await applications.findOne({
    tuitionId,
    $or: [{ studentEmail }, { studentId: req.auth.id }],
  });

  res.json({
    applied: Boolean(application),
    status: application?.status ?? null,
  });
};

const createApplication = async (req, res) => {
  const body = req.body ?? {};

  const tuitionId = text(body.tuitionId);
  const studentName = text(body.studentName);
  const studentEmail = text(body.studentEmail).toLowerCase();
  const studentPhone = text(body.studentPhone);
  const preferredSchedule = text(body.preferredSchedule);
  const studentNote = text(body.studentNote);

  // Validate input
  if (!ObjectId.isValid(tuitionId)) {
    return res.status(400).json({ error: "Invalid tuition id." });
  }
  if (!studentName) {
    return res.status(400).json({ error: "Student name is required." });
  }
  if (!isValidEmail(studentEmail)) {
    return res.status(400).json({ error: "A valid student email is required." });
  }
  if (req.auth.email && studentEmail !== req.auth.email.toLowerCase()) {
    return res
      .status(403)
      .json({ error: "Student email must match the signed-in account." });
  }
  if (!studentPhone || !isValidPhone(studentPhone)) {
    return res.status(400).json({ error: "A valid phone number is required." });
  }
  if (!preferredSchedule) {
    return res.status(400).json({ error: "Preferred schedule is required." });
  }
  if (studentNote.length > 300) {
    return res.status(400).json({ error: "Note must be 300 characters or fewer." });
  }

  // Make sure the tuition exists and is open
  const tuition = await tuitions.findOne({ _id: new ObjectId(tuitionId) });
  if (!tuition) return res.status(404).json({ error: "Tuition not found." });
  if (tuition.approvalStatus !== "approved" || !tuitionIsActive(tuition)) {
    return res
      .status(400)
      .json({ error: "This tuition is not open for applications." });
  }

  // Prevent duplicate applications
  const duplicate = await applications.findOne({
    tuitionId,
    $or: [{ studentEmail }, { studentId: req.auth.id }],
  });
  if (duplicate) {
    return res
      .status(409)
      .json({ error: "You have already applied to this tuition." });
  }

  // Build and save the application
  const now = new Date();
  const monthlyFee = Number(body.monthlyFee);

  const application = {
    tuitionId,
    tuitionTitle: text(body.tuitionTitle) || tuition.title,
    subject: text(body.subject) || tuition.subject,
    tutorId: tuition.tutorId,
    tutorEmail:
      text(body.tutorEmail) || tuition.tutorEmail || req.auth.email || "",
    monthlyFee: Number.isFinite(monthlyFee)
      ? monthlyFee
      : tuition.monthlyFee ?? 0,
    studentId: req.auth.id,
    studentName,
    studentEmail,
    studentPhone,
    preferredSchedule,
    studentNote,
    note: studentNote,
    status: "pending",
    appliedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await applications.insertOne(application);
    res.status(201).json({
      application: { ...application, _id: String(result.insertedId) },
    });
  } catch (error) {
    // A unique index on (tuitionId, studentEmail) may also reject duplicates.
    if (error?.code === 11000) {
      return res
        .status(409)
        .json({ error: "You have already applied to this tuition." });
    }
    throw error;
  }
};

/* -------------------------------------------------------------------------- */
/* Route handlers: Stripe payments                                            */
/* -------------------------------------------------------------------------- */

/** Matches a user whose _id is stored as a string or as an ObjectId. */
function userIdFilter(id) {
  const filters = [{ _id: id }];
  if (ObjectId.isValid(id)) filters.push({ _id: new ObjectId(id) });
  return { $or: filters };
}

// Saves the payment and upgrades the user to PRO.
 
async function fulfillCheckoutSession(session) {
  if (session.payment_status !== "paid") return false;

  const { userId, audience } = session.metadata ?? {};
  if (!userId) return false;

  const now = new Date();
  const stripeCustomerId = session.customer ?? null;

  // One payment document per Stripe session (no duplicates).
  await payments.updateOne(
    { stripeSessionId: session.id },
    {
      $setOnInsert: {
        stripeSessionId: session.id,
        userId,
        email: session.customer_details?.email || session.customer_email || "",
        audience: audience || "",
        plan: "pro",
        amount: (session.amount_total ?? 0) / 100,
        currency: session.currency,
        status: session.payment_status,
        stripeCustomerId,
        stripeSubscriptionId: session.subscription ?? null,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  await users.updateOne(userIdFilter(userId), {
    $set: { plan: "pro", stripeCustomerId, updatedAt: now },
  });

  return true;
}

const createCheckoutSession = async (req, res) => {
  try {
    // The price comes from the signed-in user's role, never from the client.
    const audience = req.auth.role;
    const unitAmount = PRO_PRICE_CENTS[audience];
    if (!unitAmount) {
      return res
        .status(403)
        .json({ error: "Only students and tutors can subscribe." });
    }
    if (req.auth.plan === "pro") {
      return res.status(400).json({ error: "You already have the PRO plan." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: req.auth.email || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            recurring: { interval: "month" },
            product_data: { name: PRO_PRODUCT_NAME[audience] },
          },
        },
      ],
      metadata: { userId: String(req.auth.id), audience },
      success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/payment/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Create checkout session failed:", error);
    res.status(500).json({ error: "Could not start checkout." });
  }
};

/** Called by the /payment/success page to confirm the payment. */
const verifyCheckoutSession = async (req, res) => {
  const sessionId = text(req.query.session_id);
  if (!sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid session id." });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.userId !== String(req.auth.id)) {
      return res.status(403).json({ error: "This payment is not yours." });
    }

    const paid = await fulfillCheckoutSession(session);
    res.json({ paid });
  } catch (error) {
    console.error("Verify checkout session failed:", error);
    res.status(500).json({ error: "Could not verify the payment." });
  }
};

//Stripe calls this automatically (see the Stripe CLI / Dashboard webhook). 
const handleStripeWebhook = async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      await fulfillCheckoutSession(event.data.object);
    }

    // The subscription was cancelled: move the user back to the free plan.
    if (event.type === "customer.subscription.deleted") {
      await users.updateOne(
        { stripeCustomerId: event.data.object.customer },
        { $set: { plan: "free", updatedAt: new Date() } },
      );
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handler failed:", error);
    res.status(500).json({ error: "Webhook handler failed." });
  }
};

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

// General
app.get("/", getHome);
app.get("/users", getUsers);

// Tuitions
app.get("/tuitions", getTuitions);
app.post("/tuitions", createTuition);
app.get("/tuitions/:id", getTuitionById);

// Tuitions (legacy misspelled alias, kept for backwards compatibility)
app.get("/tutions", getTuitions);
app.post("/tutions", createTuition);

// Applications
app.get("/applications/check", verifyToken, verifyStudent, checkApplication);
app.post("/applications", verifyToken, verifyStudent, createApplication);

// Stripe payments
app.post("/stripe/checkout", verifyToken, createCheckoutSession);
app.get("/stripe/verify", verifyToken, verifyCheckoutSession);
app.post("/stripe/webhook", handleStripeWebhook);

// Debug
app.get("/debug", getDebugInfo);

// Start server                                                               
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

export default app;