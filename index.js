import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";


dotenv.config();
const app = express();


app.use(express.json());
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "startling-frangipane-cf4918.netlify.app",
      
    ],
    credentials: true,
  })
);
const uri = process.env.uri;
const PORT = process.env.PORT || 5000;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: false,
  },
});

let usersCollection;
let ticketsCollection;
let bookingsCollection;
let isConnected = false;

async function connectDB() {
  if (!isConnected) {
    await client.connect();
    const db = client.db("ticket_booking_platform");
    usersCollection = db.collection("users");
    ticketsCollection = db.collection("tickets");
    bookingsCollection = db.collection("bookings");
    isConnected = true;
    console.log("🟢 MongoDB Connected");
  }
}

app.use(async (req, res, next) => {
  await connectDB();
  next();
});

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Forbidden" });
    req.user = decoded;
    next();
  });
}

const verifyAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  req.user.role === "ADMIN"
    ? next()
    : res.status(403).json({ message: "Admin only" });
};

const verifyVendor = (req, res, next) =>
  req.user.role === "VENDOR"
    ? next()
    : res.status(403).json({ message: "Vendor only" });

app.get("/", (req, res) => {
  res.send("Ticket Booking Server Running get");
});

app.get("/jwt", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ message: "Email required" });

  const user = await usersCollection.findOne({ email });
  if (!user) return res.status(404).json({ message: "User not found" });

  const token = jwt.sign(
    { email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );

  res.json({ token });
});

// user
app.get("/go", async (req, res) => {
  res.json({ message: "Hello" });
});
app.post("/users", async (req, res) => {
  const { name, email } = req.body;
  const exists = await usersCollection.findOne({ email });
  if (exists) return res.json(exists);

  const user = {
    name,
    email,
    role: "USER",
    isFraud: false,
    createdAt: new Date(),
  };

  await usersCollection.insertOne(user);
  res.json(user);
});

app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
  const users = await usersCollection.find({}).toArray();
  res.json(users);
});

app.get("/users/email/:email", verifyJWT, async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ role: user.role });
});

app.patch("/users/role/:id", verifyJWT, verifyAdmin, async (req, res) => {
  const { role } = req.body;
  if (!["ADMIN", "VENDOR", "USER"].includes(role))
    return res.status(400).json({ message: "Invalid role" });

  await usersCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { role } }
  );

  res.json({ message: "Role updated" });
});

app.patch("/users/fraud/:id", verifyJWT, verifyAdmin, async (req, res) => {
  const user = await usersCollection.findOne({
    _id: new ObjectId(req.params.id),
  });

  if (!user || user.role !== "VENDOR")
    return res.status(400).json({ message: "Invalid vendor" });

  await usersCollection.updateOne(
    { _id: user._id },
    { $set: { isFraud: true } }
  );

  await ticketsCollection.updateMany(
    { vendorEmail: user.email },
    { $set: { isHidden: true } }
  );

  res.json({ message: "Vendor marked as fraud" });
});

app.get("/transactions/user", verifyJWT, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const transactions = await bookingsCollection
      .find({ userEmail })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transactions" });
  }
});

// add ticket
app.post("/tickets", verifyJWT, verifyVendor, async (req, res) => {
  const { title, image, price, from, to, date, departureDateTime, quantity } =
    req.body;

  if (!title || !price || !quantity) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const ticket = {
    title,
    image,
    price,
    from,
    to,
    date,
    departureDateTime,
    quantity,
    vendorEmail: req.user.email,
    verificationStatus: "pending",
    isHidden: false,
    isAdvertised: false,
    createdAt: new Date(),
  };

  const result = await ticketsCollection.insertOne(ticket);
  res.status(201).json({ message: "Ticket added", ticket: result });
});

app.get("/tickets", async (req, res) => {
  const query = {
    verificationStatus: "approved",
    isHidden: { $ne: true },
  };

  if (req.query.advertised === "true") query.isAdvertised = true;

  const tickets = await ticketsCollection.find(query).toArray();
  res.json(tickets);
});

app.get("/tickets/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id))
    return res.status(404).json({ message: "Invalid ticket id" });

  const ticket = await ticketsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });

  if (!ticket) return res.status(404).json({ message: "Ticket not found" });

  res.json(ticket);
});

app.get("/vendor/tickets", verifyJWT, verifyVendor, async (req, res) => {
  const tickets = await ticketsCollection
    .find({ vendorEmail: req.user.email })
    .toArray();
  res.json(tickets);
});

// Booked
app.post("/bookings", verifyJWT, async (req, res) => {
  const { ticketId, quantity, totalPrice } = req.body;

  const ticket = await ticketsCollection.findOne({
    _id: new ObjectId(ticketId),
  });

  if (!ticket) return res.status(404).json({ message: "Ticket not found" });

  if (quantity > ticket.quantity)
    return res.status(400).json({ message: "Not enough tickets available" });

  const user = await usersCollection.findOne({ email: req.user.email });

  const booking = {
    ticketId: ticket._id,
    ticketTitle: ticket.title,
    ticketImage: ticket.image,
    from: ticket.from,
    to: ticket.to,
    departureDateTime: ticket.departureDateTime,
    quantity,
    totalPrice,
    userName: user?.name || "Unknown",
    userEmail: req.user.email,
    vendorEmail: ticket.vendorEmail,
    status: "pending",
    createdAt: new Date(),
  };

  await bookingsCollection.insertOne(booking);

  await ticketsCollection.updateOne(
    { _id: ticket._id },
    { $inc: { quantity: -quantity } }
  );

  res.json({ message: "Booking created", booking });
});

app.patch(
  "/bookings/accepted/:id",
  verifyJWT,
  verifyVendor,
  async (req, res) => {
    await bookingsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: "accepted" } }
    );
    res.json({ message: "Booking accepted" });
  }
);

app.patch(
  "/bookings/rejected/:id",
  verifyJWT,
  verifyVendor,
  async (req, res) => {
    await bookingsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: "rejected" } }
    );
    res.json({ message: "Booking rejected" });
  }
);

app.get("/bookings/vendor", verifyJWT, verifyVendor, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({ vendorEmail: req.user.email })
      .project({
        _id: 1,
        userName: 1,
        userEmail: 1,
        ticketTitle: 1,
        ticketImage: 1,
        quantity: 1,
        totalPrice: 1,
        status: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

app.get("/bookings/user", verifyJWT, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({ userEmail: req.user.email })
      .toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

app.patch("/bookings/pay/:id", verifyJWT, async (req, res) => {
  const booking = await bookingsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!booking) return res.status(404).json({ message: "Booking not found" });

  if (new Date(booking.departureDateTime) < new Date())
    return res.status(400).json({ message: "Departure passed" });

  await bookingsCollection.updateOne(
    { _id: booking._id },
    { $set: { status: "paid" } }
  );

  await ticketsCollection.updateOne(
    { _id: new ObjectId(booking.ticketId) },
    { $inc: { quantity: -booking.quantity } }
  );

  res.json({ message: "Payment successful" });
});

// Admin
app.get("/admin/tickets", verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const tickets = await ticketsCollection.find({}).toArray();
    res.json(tickets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch tickets" });
  }
});

app.patch("/admin/tickets/:id", verifyJWT, verifyAdmin, async (req, res) => {
  const ticketId = req.params.id;
  const { status } = req.body;

  if (!["approved", "rejected", "hidden"].includes(status))
    return res.status(400).json({ message: "Invalid status" });

  try {
    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(ticketId),
    });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    await ticketsCollection.updateOne(
      { _id: ticket._id },
      { $set: { verificationStatus: status } }
    );

    res.json({ message: `Ticket status updated to ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update ticket" });
  }
});

app.patch(
  "/admin/tickets/advertise/:id",
  verifyJWT,
  verifyAdmin,
  async (req, res) => {
    const ticketId = req.params.id;

    if (!ObjectId.isValid(ticketId))
      return res.status(400).json({ message: "Invalid ticket ID" });

    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(ticketId),
    });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    const newStatus = !ticket.isAdvertised;

    await ticketsCollection.updateOne(
      { _id: ticket._id },
      { $set: { isAdvertised: newStatus } }
    );

    res.json({
      message: `Ticket ${newStatus ? "advertised" : "un-advertised"}`,
      isAdvertised: newStatus,
    });
  }
);
app.listen(PORT, async () => {
  try {
    await connectDB();
    console.log(` Server running at port ${PORT}`);
  } catch (err) {
    console.error(" Failed to connect MongoDB:", err);
  }
});

