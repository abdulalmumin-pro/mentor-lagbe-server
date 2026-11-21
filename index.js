import dns from "node:dns";
import express from "express";
import { MongoClient } from "mongodb";
import "dotenv/config";
import cors from "cors";

// Fix DNS issue
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
const port = process.env.PORT || 5000;

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
  res.send(result);
};

const createTuition = async (req, res) => {
  const tuition = req.body;
  const result = await tuitions.insertOne(tuition);
  res.send(result);
};

app.get("/tuitions", getTuitions);
app.post("/tuitions", createTuition);


app.get("/tutions", getTuitions);
app.post("/tutions", createTuition);

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