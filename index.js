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

const connectedClient = await connectToMongoDB();
const database = client.db("mentor-lagbe-db");
const users = database.collection("user");
const jobs = database.collection("jobs");

// Home Route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/users", async(req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

// Start Server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
export default app;