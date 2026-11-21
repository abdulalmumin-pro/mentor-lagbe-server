# MentorLagbe Server

Express + MongoDB backend for **MentorLagbe**, a tuition marketplace that connects students with tutors.

> **Status:** early version. The endpoints below have **no authentication yet** (see [Known limitations](#known-limitations--todo)). Do not expose this server publicly in its current state.

## Tech stack

- [Node.js](https://nodejs.org/) 18+ (ES modules, top-level `await`)
- [Express](https://expressjs.com/)
- [MongoDB](https://www.mongodb.com/) Atlas via the official `mongodb` driver
- `dotenv` for environment variables
- `cors` for cross-origin requests

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

Create a `.env` file in the server root (never commit it):

```env
PORT=5000
DB_USER=your_mongodb_username
DB_PASSWORD=your_mongodb_password
```

| Variable      | Required | Description                                |
| ------------- | -------- | ------------------------------------------ |
| `PORT`        | No       | Port the server listens on (default: 5000) |
| `DB_USER`     | Yes      | MongoDB Atlas database user                |
| `DB_PASSWORD` | Yes      | MongoDB Atlas database password            |

If your password contains special characters (`@`, `:`, `/`, `#`, ...), URL-encode it, for example with `encodeURIComponent`.

### 3. Allow your IP in MongoDB Atlas

In Atlas go to **Network Access** and add your current IP address, otherwise the connection will fail.

### 4. Run the server

```bash
node index.js
```

Replace `index.js` with your entry file name, or add a script to `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  }
}
```

Then run `npm run dev` during development. On success you will see:

```
You successfully connected to MongoDB!
Example app listening on port 5000
```

## Database

- **Database name:** `mentor-lagbe-db`

| Collection | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| `user`     | User accounts, created and managed by Better Auth in the client app  |
| `tuitions` | Tuition posts created by tutors                                      |

The server connects to the same database that the Next.js client (Better Auth) uses.

## API endpoints

Base URL (local): `http://localhost:5000`

| Method | Endpoint     | Description                                         |
| ------ | ------------ | --------------------------------------------------- |
| GET    | `/`          | Health check, returns `Hello World!`                |
| GET    | `/users`     | Returns all documents from the `user` collection    |
| GET    | `/tuitions`  | Returns all tuition posts                           |
| POST   | `/tuitions`  | Creates a tuition post from the JSON request body   |
| GET    | `/tutions`   | Alias of `GET /tuitions` (kept for an old typo)     |
| POST   | `/tutions`   | Alias of `POST /tuitions` (kept for an old typo)    |
| GET    | `/debug`     | Shows the database name and document counts         |

### Example: create a tuition

```bash
curl -X POST http://localhost:5000/tuitions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "HSC Physics Tutor Needed",
    "subject": "Physics",
    "classLevel": "HSC",
    "mode": "Online",
    "location": "Dhaka",
    "monthlyFee": 3000,
    "daysPerWeek": 3,
    "description": "Looking for an experienced physics tutor."
  }'
```

## Project structure

```
mentor-lagbe-server/
├── index.js        # Express app, MongoDB connection, routes
├── package.json
├── .env            # secrets (not committed)
└── .gitignore
```

## Known limitations / TODO

These must be fixed before any public deployment:

- [ ] **`GET /users` is public** and returns every user record, including emails and roles. Remove it or restrict it to admins.
- [ ] **`POST /tuitions` has no authentication or validation.** Anyone can insert any data. Only signed-in tutors should create posts, and the body should be validated (required fields, types, no client-controlled `approvalStatus`).
- [ ] **`GET /tuitions` returns everything**, including unapproved posts. Public listings should only return documents with `approvalStatus: "approved"` and `status: "active"`.
- [ ] **`/debug` is public.** Remove it or protect it.
- [ ] **CORS is open to all origins** (`cors()` with no options). Restrict it to the client's domain.
- [ ] **Remove the duplicate `/tutions` routes** once nothing depends on them.
- [ ] **Authentication is handled by Better Auth in the Next.js client.** If this server needs to know who the user is, verify the session instead of trusting the request body.
- [ ] The tuition and application features used by the client currently live in the Next.js route handlers (`/api/tuitions`, `/api/applications`). Decide on one backend to avoid duplicated logic.

## Security notes

- Never commit `.env` or database credentials. Make sure `.env` is listed in `.gitignore`.
- If credentials were ever committed or shared, rotate the database password in Atlas.
- The `dns.setServers(["8.8.8.8", "1.1.1.1"])` line in the code is a workaround for DNS resolution problems with `mongodb+srv://` URIs on some networks. Remove it if your network resolves Atlas hosts correctly.

## License

Add a license of your choice (for example MIT).