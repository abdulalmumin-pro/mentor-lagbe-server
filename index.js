import dns from "node:dns";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Fix DNS issue
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
const port = process.env.PORT || 5000;

// Better Auth issues the JWTs and exposes its public keys at /api/auth/jwks.
const AUTH_URL = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
).replace(/\/+$/, "");
const jwks = createRemoteJWKSet(new URL(`${AUTH_URL}/api/auth/jwks`));

// Middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.fcqp05s.mongodb.net/`,
);

// MongoDB Connection
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

// Helpers
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

// Home Route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/users", async (req, res) => {
  const result = await users.find({}).toArray();
  res.send(result);
});

// tuitions related api
const getTuitions = async (req, res) => {
  const result = await tuitions.find().toArray();
  res.send(result.map(serializeTuition));
};

const createTuition = async (req, res) => {
  const tuition = req.body;
  const result = await tuitions.insertOne(tuition);
  res.send(result);
};

app.get("/tuitions", getTuitions);
app.post("/tuitions", createTuition);

app.get("/tuitions/:id", async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid tuition id." });
  }

  const tuition = await tuitions.findOne({ _id: new ObjectId(id) });
  if (!tuition) return res.status(404).json({ error: "Tuition not found." });

  res.json({ tuition: serializeTuition(tuition) });
});

app.get("/tutions", getTuitions);
app.post("/tutions", createTuition);

// applications related api
app.get("/applications/check", verifyToken, verifyStudent, async (req, res) => {
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
});

app.post("/applications", verifyToken, verifyStudent, async (req, res) => {
  const body = req.body ?? {};

  const tuitionId = text(body.tuitionId);
  const studentName = text(body.studentName);
  const studentEmail = text(body.studentEmail).toLowerCase();
  const studentPhone = text(body.studentPhone);
  const preferredSchedule = text(body.preferredSchedule);
  const studentNote = text(body.studentNote);

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

  const tuition = await tuitions.findOne({ _id: new ObjectId(tuitionId) });
  if (!tuition) return res.status(404).json({ error: "Tuition not found." });
  if (tuition.approvalStatus !== "approved" || !tuitionIsActive(tuition)) {
    return res
      .status(400)
      .json({ error: "This tuition is not open for applications." });
  }

  const duplicate = await applications.findOne({
    tuitionId,
    $or: [{ studentEmail }, { studentId: req.auth.id }],
  });
  if (duplicate) {
    return res
      .status(409)
      .json({ error: "You have already applied to this tuition." });
  }

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
});

app.get("/debug", async (_req, res) => {
  const collections = await database.listCollections().toArray();
  const counts = {};
  for (const c of collections) {
    counts[c.name] = await database.collection(c.name).countDocuments();
  }
  res.json({ database: database.databaseName, collections: counts });
});

// Start Server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

export default app;
