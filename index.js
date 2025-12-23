// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");
console.log("Stripe key exists:", !!process.env.STRIPE_SECRET);

let isConnected = false;

const app = express();
const port = process.env.PORT || 3000;

// middleware
// app.use(cors());

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://tixgo.vercel.app",
      "https://tixgo.netlify.app",
    ],
  })
);

app.use(express.json());

app.get("/", (req, res) => {
  res.send("TixGo backend is running");
});

/* ===============================
    Firebase Admin Init 
================================ */

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ===============================
    JWT Middleware
================================ */
const verifyJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Invalid token" });
  }
};

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ujnwtbv.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let usersCollection;
let vendorsCollection;
let ticketsCollection;
let bookingsCollection;
let paymentsCollection;

// Utility: safe ObjectId convert
function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// Start function
async function run() {
  try {
    db = client.db("tixgo_db");
    usersCollection = db.collection("users");
    vendorsCollection = db.collection("vendors");
    ticketsCollection = db.collection("tickets");
    bookingsCollection = db.collection("bookings");
    paymentsCollection = db.collection("payments");

    // ------------------
    // DATABASE INDEXES
    // ------------------
    // await bookingsCollection.createIndex({ customerEmail: 1 });
    // await bookingsCollection.createIndex({ vendorEmail: 1 });

    // await paymentsCollection.createIndex(
    //   { transactionId: 1 },
    //   { unique: true }
    // );

    // await ticketsCollection.createIndex({ vendorEmail: 1 });

    /* ===============================
        Admin Middleware
    ================================ */
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded?.email;
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden" });
      }
      next();
    };

    /* ===============================
         Vendor Middleware
    ================================ */
    const verifyVendor = async (req, res, next) => {
      const email = req.decoded?.email;
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "vendor") {
        return res.status(403).send({ message: "Forbidden" });
      }

      if (user.isFraud === true) {
        return res.status(403).send({
          message:
            "Your vendor account has been suspended due to fraud activity",
        });
      }

      req.vendor = user;
      next();
    };

    // // ----------------------------------------------------
    // // ROOT
    // // ----------------------------------------------------
    // app.get("/", (req, res) => {
    //   res.send("Tixgo backend is running! 🚀");
    // });

    // || PAYMENT API ||

    // ------------------
    // CREATE TICKET CHECKOUT Stripe
    // ------------------
    app.post("/create-ticket-checkout", async (req, res) => {
      try {
        const { bookingId } = req.body;
        const bookingOid = toObjectId(bookingId);

        if (!bookingOid) {
          return res.status(400).send({ message: "Invalid booking id" });
        }

        const booking = await bookingsCollection.findOne({ _id: bookingOid });
        if (!booking) {
          return res.status(404).send({ message: "Booking not found" });
        }

        if (booking.status === "paid") {
          return res.status(400).send({ message: "Already paid" });
        }

        if (booking.status !== "accepted") {
          return res
            .status(400)
            .send({ message: "Booking must be accepted before payment" });
        }

        const ticket = await ticketsCollection.findOne({
          _id: booking.ticketId,
        });
        if (!ticket) {
          return res.status(404).send({ message: "Ticket not found" });
        }

        if (ticket.departure <= new Date()) {
          return res.status(400).send({ message: "Departure time passed" });
        }

        const unitPrice = Number(booking.price);
        const quantity = Number(booking.quantity);

        if (!unitPrice || !quantity || unitPrice <= 0 || quantity <= 0) {
          return res.status(400).send({ message: "Invalid price or quantity" });
        }

        const unitAmount = Math.round(unitPrice * 100);

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: unitAmount,
                product_data: {
                  name: booking.title,
                },
              },
              quantity,
            },
          ],
          metadata: {
            bookingId: booking._id.toString(),
            ticketId: booking.ticketId.toString(),
            quantity: quantity.toString(),
          },
          success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
        });
        console.log("SITE_DOMAIN:", process.env.SITE_DOMAIN);

        res.send({ url: session.url });
      } catch (err) {
        console.error("Stripe Checkout Error:", err);
        res.status(500).send({ message: err.message });
      }
    });

    // VERIFY PAYMENT
    app.post("/payments/verify", async (req, res) => {
      try {
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment not completed" });
        }

        const bookingId = new ObjectId(session.metadata.bookingId);
        const booking = await bookingsCollection.findOne({ _id: bookingId });

        if (!booking) {
          return res.status(404).send({ message: "Booking not found" });
        }

        
        const exists = await paymentsCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (exists) {
          return res.send({ success: true });
        }

       
        await paymentsCollection.insertOne({
          bookingId,
          ticketId: booking.ticketId,
          customerEmail: booking.customerEmail,
          ticketTitle: booking.title, 
          amount: session.amount_total / 100,
          quantity: booking.quantity,
          currency: session.currency,
          transactionId: session.payment_intent,
          paidAt: new Date(),
        });

       
        await bookingsCollection.updateOne(
          { _id: bookingId },
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
            },
          }
        );

        res.send({ success: true });
      } catch (err) {
        console.error("Payment verify error:", err);
        res.status(500).send({ message: "Payment verification failed" });
      }
    });

    // routes/payments.js or index.js

    app.post(
      "/payments/create-checkout-session",
      verifyJWT,
      async (req, res) => {
        try {
          const { bookingId } = req.body;

          const bookingOid = toObjectId(bookingId);
          if (!bookingOid) {
            return res.status(400).send({ message: "Invalid bookingId" });
          }

          const booking = await bookingsCollection.findOne({ _id: bookingOid });
          if (!booking) {
            return res.status(404).send({ message: "Booking not found" });
          }

          if (booking.paymentStatus === "paid") {
            return res.status(400).send({ message: "Already paid" });
          }

          if (booking.status !== "accepted") {
            return res.status(400).send({ message: "Booking not accepted" });
          }

          const unitAmount = Math.round(Number(booking.price) * 100);
          const quantity = Number(booking.quantity);

          if (unitAmount <= 0 || quantity <= 0) {
            return res
              .status(400)
              .send({ message: "Invalid price or quantity" });
          }

          if (!process.env.SITE_DOMAIN) {
            throw new Error("SITE_DOMAIN is not defined");
          }

          const session = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            customer_email: booking.customerEmail,

            line_items: [
              {
                price_data: {
                  currency: "usd",
                  unit_amount: unitAmount,
                  product_data: {
                    name: booking.title, 
                  },
                },
                quantity,
              },
            ],

            metadata: {
              bookingId: booking._id.toString(),
            },

            success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
          });

          res.send({ url: session.url });
        } catch (err) {
          console.error("Stripe Error FULL:", err);
          res.status(500).send({ message: err.message });
        }
      }
    );

    // ------------------
    // PAYMENT SUCCESS
    // ------------------
    app.post("/stripe/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log("Stripe Session:", session);
        if (session.payment_status !== "paid") {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
        }

        const bookingId = toObjectId(session.metadata.bookingId);
        if (!bookingId) {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
        }

        const alreadyPaid = await paymentsCollection.findOne({
          transactionId: session.payment_intent,
        });

        // return res.redirect(
        //   `${process.env.SITE_DOMAIN}/payment-success?session_id=${sessionId}`
        // );
        res.send({ success: true, message: "Payment verified" });
      } catch (err) {
        console.error("Payment Success Error:", err);
        // return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
      }
    });

    // ------------------
    // PAYMENT CANCELLED
    // ------------------
    app.get("/stripe/payment-cancelled", async (req, res) => {
      try {
        const bookingId = toObjectId(req.query.bookingId);
        if (!bookingId) {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-cancelled`);
        }

        const bookingOid = toObjectId(bookingId);
        if (!bookingOid) {
          return res.status(400).send({ message: "Invalid bookingId" });
        }

        const booking = await bookingsCollection.findOne({ _id: bookingOid });

        if (booking && booking.status === "accepted") {
          await ticketsCollection.updateOne(
            { _id: booking.ticketId },
            { $inc: { quantity: booking.quantity } }
          );

          await bookingsCollection.updateOne(
            { _id: bookingId },
            { $set: { status: "cancelled" } }
          );
        }

        return res.redirect(`${process.env.SITE_DOMAIN}/payment-cancelled`);
      } catch (err) {
        return res.redirect(`${process.env.SITE_DOMAIN}/payment-cancelled`);
      }
    });

    // ------------------
    // Payment Related API
    // ------------------
    app.get("/payments", verifyJWT, async (req, res) => {
      const email = req.decoded.email;

      const payments = await paymentsCollection
        .find({ customerEmail: email })
        .sort({ paidAt: -1 })
        .toArray();

      res.send(payments);
    });

    /* ===============================
       USERS
    ================================ */

    app.get("/users/role", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const { email, name, photo } = req.body;
      if (!email) return res.status(400).send({ message: "email required" });

      const existingUser = await usersCollection.findOne({ email });

      if (existingUser) {
        await usersCollection.updateOne(
          { email },
          {
            $set: {
              name: name || existingUser.name,
              photo: photo || existingUser.photo,
              lastLogin: new Date(),
            },
          }
        );
        return res.send({ success: true, message: "User updated" });
      }

      await usersCollection.insertOne({
        email,
        name: name || "",
        photo: photo || "",
        role: "user",
        isFraud: false,
        createdAt: new Date(),
      });

      res.send({ success: true, message: "User created" });
    });

    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const q = {};
      if (req.query.role) q.role = req.query.role;
      const users = await usersCollection
        .find(q)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(users);
    });

    app.get("/users/profile", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });

      if (!user) return res.status(404).send({ message: "User not found" });

      res.send(user);
    });

    app.put("/users/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const { name, photo, phone } = req.body;

      const update = {
        ...(name && { name }),
        ...(photo && { photo }),
        ...(phone && { phone }),
      };

      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: update }
      );

      res.send({ success: true, result });
    });

    /* ===============================
                  VENDORS
      ================================ */

    app.post("/vendors", verifyJWT, async (req, res) => {
      try {
        const vendor = req.body;
        if (!vendor?.userEmail)
          return res.status(400).send({ message: "userEmail required" });
        vendor.createdAt = new Date();
        vendor.verified = vendor.verified || false;

        const result = await vendorsCollection.updateOne(
          { userEmail: vendor.userEmail },
          { $set: vendor },
          { upsert: true }
        );
        res.send({ success: true, result });
      } catch (err) {
        console.error("POST /vendors error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/vendors", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const q = {};
        if (req.query.verified !== undefined)
          q.verified = req.query.verified === "true";
        const vendors = await vendorsCollection
          .find(q)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(vendors);
      } catch (err) {
        console.error("GET /vendors error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/vendors/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;

        if (
          email !== req.decoded.email &&
          (await usersCollection.findOne({ email: req.decoded.email }))
            ?.role !== "admin"
        ) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const vendor = await vendorsCollection.findOne({ userEmail: email });
        if (!vendor)
          return res.status(404).send({ message: "Vendor not found" });

        res.send(vendor);
      } catch (err) {
        console.error("GET /vendors/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.put("/vendors/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }
        const update = req.body;
        const result = await vendorsCollection.updateOne(
          { userEmail: email },
          { $set: update }
        );

        res.send(result);
      } catch (err) {
        console.error("PUT /vendors/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    /*   ===============================
                     TICKETS
         =============================== */

    app.patch("/tickets/:id", verifyJWT, async (req, res) => {
      try {
        const { id } = req.params;
        const oid = toObjectId(id);
        if (!oid) return res.status(400).send({ message: "Invalid id" });

        const updatedData = { ...req.body };

        delete updatedData.verificationStatus;
        delete updatedData.vendorEmail;
        delete updatedData.vendorName;
        delete updatedData.createdAt;
        delete updatedData._id;

        const ticket = await ticketsCollection.findOne({ _id: oid });
        if (!ticket) {
          return res.status(404).send({ message: "Ticket not found" });
        }
        if (ticket.vendorEmail !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }
        if (ticket.verificationStatus === "rejected") {
          return res
            .status(403)
            .send({ message: "Rejected tickets cannot be updated" });
        }
        if ("perks" in updatedData) {
          if (!Array.isArray(updatedData.perks)) {
            updatedData.perks = [];
          }
        } else {
          delete updatedData.perks;
        }

        if (updatedData.price) updatedData.price = Number(updatedData.price);
        if (updatedData.quantity)
          updatedData.quantity = Number(updatedData.quantity);

        const result = await ticketsCollection.updateOne(
          { _id: oid },
          { $set: updatedData }
        );

        res.send({ success: true, modifiedCount: result.modifiedCount });
      } catch (err) {
        console.error("PATCH /tickets/:id error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.post("/tickets", verifyJWT, verifyVendor, async (req, res) => {
      try {
        const {
          title,
          from,
          to,
          transport,
          price,
          quantity,
          departure,
          image,
          perks,
        } = req.body;

        if (
          !title ||
          !from ||
          !to ||
          !transport ||
          !price ||
          !quantity ||
          !departure ||
          !image
        ) {
          return res
            .status(400)
            .send({ message: "All required fields missing" });
        }

        const safePerks = Array.isArray(perks) ? perks : [];

        const ticket = {
          title,
          from,
          to,
          transport,
          price: Number(price),
          quantity: Number(quantity),
          departure: new Date(departure),
          image,
          perks: safePerks,
          vendorEmail: req.decoded.email,
          verificationStatus: "pending",
          advertised: false,
          createdAt: new Date(),
        };

        const result = await ticketsCollection.insertOne(ticket);
        res.send({ success: true, ticketId: result.insertedId });
      } catch (error) {
        console.error("Create ticket error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/tickets", async (req, res) => {
      try {
        const { verificationStatus, advertised, limit, sort, vendorEmail } =
          req.query;

        const filter = { hidden: { $ne: true } };

        if (verificationStatus) filter.verificationStatus = verificationStatus;
        if (advertised !== undefined) filter.advertised = advertised === "true";
        if (vendorEmail) filter.vendorEmail = vendorEmail;

        let cursor = ticketsCollection.find(filter);

        if (sort === "newest") cursor = cursor.sort({ createdAt: -1 });
        if (limit) cursor = cursor.limit(parseInt(limit));

        const result = await cursor.toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/tickets/vendor/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }
        const tickets = await ticketsCollection
          .find({
            vendorEmail: email,
            hidden: { $ne: true },
          })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(tickets);
      } catch (err) {
        console.error("GET /tickets/vendor/:email error:", err);
        res.status(500).send({ error: "Failed to fetch vendor tickets" });
      }
    });

    app.get("/tickets/advertised", async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 6;

        const advertisedTickets = await ticketsCollection
          .find({
            advertised: true,
            verificationStatus: "approved",
            hidden: { $ne: true },
          })
          .limit(limit)
          .toArray();

        res.send(advertisedTickets);
      } catch (error) {
        res.status(400).send({ message: "Failed to fetch advertised tickets" });
      }
    });

    app.patch(
      "/tickets/:id/approve",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const oid = toObjectId(id);
          if (!oid) return res.status(400).send({ message: "invalid id" });

          const result = await ticketsCollection.updateOne(
            { _id: oid },
            { $set: { verificationStatus: "approved" } }
          );
          if (!result.matchedCount)
            return res.status(404).send({ message: "Ticket not found" });

          res.send({ success: true, modifiedCount: result.modifiedCount });
        } catch (err) {
          console.error("PATCH /tickets/:id/approve error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    app.patch(
      "/tickets/:id/reject",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const oid = toObjectId(id);
          if (!oid) return res.status(400).send({ message: "invalid id" });

          const result = await ticketsCollection.updateOne(
            { _id: oid },
            { $set: { verificationStatus: "rejected" } }
          );
          if (!result.matchedCount)
            return res.status(404).send({ message: "Ticket not found" });

          res.send({ success: true, modifiedCount: result.modifiedCount });
        } catch (err) {
          console.error("PATCH /tickets/:id/reject error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    app.patch(
      "/tickets/:id/advertise",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { advertised } = req.body;
          if (typeof advertised !== "boolean")
            return res
              .status(400)
              .send({ message: "advertised must be boolean" });

          if (advertised) {
            const count = await ticketsCollection.countDocuments({
              verificationStatus: "approved",
              advertised: true,
            });
            if (count >= 6) {
              return res
                .status(400)
                .send({ message: "Cannot advertise more than 6 tickets" });
            }
          }

          const oid = toObjectId(id);
          if (!oid) return res.status(400).send({ message: "invalid id" });

          const result = await ticketsCollection.updateOne(
            { _id: oid },
            { $set: { advertised } }
          );
          if (!result.matchedCount)
            return res.status(404).send({ message: "Ticket not found" });

          res.send({ success: true, modifiedCount: result.modifiedCount });
        } catch (err) {
          console.error("PATCH /tickets/:id/advertise error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    // Delete ticket
    app.delete("/tickets/:id", verifyJWT, async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });
      const ticket = await ticketsCollection.findOne({ _id: id });
      if (!ticket) {
        return res.status(404).send({ message: "Ticket not found" });
      }
      if (ticket.vendorEmail !== req.decoded.email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      if (ticket.verificationStatus === "rejected") {
        return res.status(403).send({
          message: "Rejected tickets cannot be deleted",
        });
      }

      const result = await ticketsCollection.deleteOne({ _id: id });
      res.send(result);
    });

    app.get("/tickets/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const oid = toObjectId(id);
        if (!oid) return res.status(400).send({ message: "invalid id" });

        const ticket = await ticketsCollection.findOne({
          _id: oid,
          hidden: { $ne: true },
        });
        if (!ticket)
          return res.status(404).send({ message: "Ticket not found" });
        res.send(ticket);
      } catch (err) {
        console.error("GET /tickets/:id error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    /* ===============================
                  BOOKINGS
       ================================ */

    app.post("/bookings", verifyJWT, async (req, res) => {
      try {
        const { ticketId, quantity, customerEmail } = req.body;

        if (customerEmail !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (!ticketId || !quantity || quantity <= 0) {
          return res
            .status(400)
            .send({ message: "ticketId and valid quantity required" });
        }

        const ticketOid = toObjectId(ticketId);
        if (!ticketOid)
          return res.status(400).send({ message: "Invalid ticketId" });

        const ticket = await ticketsCollection.findOne({ _id: ticketOid });
        if (!ticket)
          return res.status(404).send({ message: "Ticket not found" });

        if (ticket.verificationStatus !== "approved") {
          return res.status(400).send({ message: "Ticket not approved" });
        }

        const reserve = await ticketsCollection.updateOne(
          { _id: ticketOid, quantity: { $gte: quantity } },
          { $inc: { quantity: -quantity } }
        );

        if (!reserve.modifiedCount) {
          return res
            .status(400)
            .send({ message: "Not enough tickets available" });
        }

        const newBooking = {
          ticketId: ticket._id,
          vendorEmail: ticket.vendorEmail,
          customerEmail,
          title: ticket.title,
          price: ticket.price,
          quantity,
          status: "pending",
          createdAt: new Date(),
        };

        const result = await bookingsCollection.insertOne(newBooking);

        res.send({
          success: true,
          bookingId: result.insertedId,
        });
      } catch (err) {
        console.error("POST /bookings error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/bookings", verifyJWT, async (req, res) => {
      try {
        const email = req.query.email;

        if (email !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const bookings = await bookingsCollection
          .aggregate([
            { $match: { customerEmail: email } },
            {
              $lookup: {
                from: "tickets",
                localField: "ticketId",
                foreignField: "_id",
                as: "ticket",
              },
            },
            { $unwind: "$ticket" },
            {
              $project: {
                _id: 1,
                quantity: 1,
                status: 1,
                createdAt: 1,

                title: "$ticket.title",
                image: "$ticket.image",
                from: "$ticket.from",
                to: "$ticket.to",
                departure: "$ticket.departure",
                price: "$ticket.price",
              },
            },
          ])
          .toArray();

        res.send(bookings);
      } catch (err) {
        console.error("GET /bookings error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.patch("/bookings/:id/accept", verifyJWT, async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const booking = await bookingsCollection.findOne({ _id: id });
      if (!booking)
        return res.status(404).send({ message: "Booking not found" });

      if (booking.vendorEmail !== req.decoded.email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      if (booking.status !== "pending") {
        return res
          .status(400)
          .send({ message: "Only pending bookings can be accepted" });
      }

      const result = await bookingsCollection.updateOne(
        { _id: id },
        { $set: { status: "accepted", acceptedAt: new Date() } }
      );

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    app.patch("/bookings/:id/reject", verifyJWT, async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const booking = await bookingsCollection.findOne({ _id: id });
      if (!booking)
        return res.status(404).send({ message: "Booking not found" });

      if (booking.vendorEmail !== req.decoded.email)
        return res.status(403).send({ message: "Forbidden" });

      if (booking.status !== "pending") {
        return res
          .status(400)
          .send({ message: "Only pending bookings can be rejected" });
      }
      await ticketsCollection.updateOne(
        { _id: booking.ticketId },
        { $inc: { quantity: booking.quantity } }
      );

      await bookingsCollection.updateOne(
        { _id: id },
        { $set: { status: "rejected", rejectedAt: new Date() } }
      );

      res.send({ success: true });
    });

    app.get("/bookings/vendor/:email", verifyJWT, async (req, res) => {
      try {
        const vendorEmail = req.params.email;

        if (vendorEmail !== req.decoded.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const bookings = await bookingsCollection
          .aggregate([
            {
              $lookup: {
                from: "tickets",
                localField: "ticketId",
                foreignField: "_id",
                as: "ticket",
              },
            },
            { $unwind: "$ticket" },

            {
              $match: {
                "ticket.vendorEmail": vendorEmail,
              },
            },

            {
              $project: {
                _id: 1,
                customerEmail: 1,
                quantity: 1,
                status: 1,
                createdAt: 1,

                ticketTitle: "$ticket.title",
                unitPrice: "$ticket.price",
              },
            },
          ])
          .toArray();

        res.send(bookings);
      } catch (err) {
        console.error("GET /bookings/vendor error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    /* ===============================
        ADMIN PROFILE 
    ================================ */
    app.get("/admin/profile", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const email = req.decoded.email;

        const adminUser = await usersCollection.findOne({ email });

        if (!adminUser) {
          return res.status(404).send({ message: "Admin not found" });
        }

        res.send({
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
          photoURL: adminUser.photo || "",
          phone: adminUser.phone || "",
          createdAt: adminUser.createdAt || null,
        });
      } catch (error) {
        console.error("Admin profile error:", error);
        res.status(500).send({ message: "Failed to load admin profile" });
      }
    });

    app.get("/admin/stats", verifyJWT, verifyAdmin, async (req, res) => {
      const usersCount = await usersCollection.countDocuments();
      const vendorsCount = await vendorsCollection.countDocuments();
      const ticketsCount = await ticketsCollection.countDocuments();
      const bookingsCount = await bookingsCollection.countDocuments();
      res.send({ usersCount, vendorsCount, ticketsCount, bookingsCount });
    });

    app.get(
      "/admin/vendors/pending",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const pending = await vendorsCollection
            .find({ verified: false })
            .toArray();
          res.send(pending);
        } catch (err) {
          console.error("GET /admin/vendors/pending error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    app.patch(
      "/admin/vendors/:email/verify",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const email = req.params.email;
          const verify = req.body.verify === true;
          const result = await vendorsCollection.updateOne(
            { userEmail: email },
            { $set: { verified: verify } }
          );
          res.send({ success: true, result });
        } catch (err) {
          console.error("PATCH /admin/vendors/:email/verify error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    /* ===============================
       ADMIN REVENUE
    ================================ */
    app.get(
      "/admin/revenue-overview",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const revenueStats = await paymentsCollection
          .aggregate([
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$amount" },
                ticketsSold: { $sum: "$quantity" },
              },
            },
          ])
          .toArray();

        const ticketsAdded = await ticketsCollection.countDocuments();

        res.send({
          totalRevenue: revenueStats[0]?.totalRevenue || 0,
          ticketsSold: revenueStats[0]?.ticketsSold || 0,
          ticketsAdded,
        });
      }
    );

    /* ===============================
             VENDOR REVENUE
       ================================ */
    app.get(
      "/vendor/revenue-overview",
      verifyJWT,
      verifyVendor,
      async (req, res) => {
        try {
          const email = req.decoded.email;
          const tickets = await ticketsCollection
            .find({
              vendorEmail: email,
              verificationStatus: "approved",
              hidden: { $ne: true },
            })
            .toArray();

          const ticketsAdded = tickets.length;

          const payments = await paymentsCollection
            .aggregate([
              {
                $lookup: {
                  from: "tickets",
                  localField: "ticketId",
                  foreignField: "_id",
                  as: "ticket",
                },
              },
              { $unwind: "$ticket" },
              {
                $match: {
                  "ticket.vendorEmail": email,
                },
              },
            ])
            .toArray();

          const ticketsSold = payments.reduce(
            (sum, p) => sum + (p.quantity || 0),
            0
          );

          const totalRevenue = payments.reduce(
            (sum, p) => sum + (p.amount || 0),
            0
          );

          res.send({
            totalRevenue,
            ticketsSold,
            ticketsAdded,
          });
        } catch (err) {
          console.error("Vendor revenue error:", err);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    app.get(
      "/admin/revenue-chart",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const chartData = await paymentsCollection
          .aggregate([
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } },
                revenue: { $sum: "$amount" },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray();

        res.send(chartData);
      }
    );

    app.get("/admin/users", verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.patch(
      "/admin/users/:id/make-admin",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const id = toObjectId(req.params.id);
        await usersCollection.updateOne(
          { _id: id },
          { $set: { role: "admin" } }
        );
        res.send({ success: true });
      }
    );

    app.patch(
      "/admin/users/:id/make-vendor",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).send({ message: "Invalid id" });

        const result = await usersCollection.updateOne(
          { _id: id },
          { $set: { role: "vendor", isFraud: false } }
        );

        res.send({ success: true });
      }
    );

    app.patch(
      "/admin/users/:id/mark-fraud",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).send({ message: "Invalid id" });

        const user = await usersCollection.findOne({ _id: id });
        if (!user || user.role !== "vendor") {
          return res.status(400).send({ message: "Not a vendor" });
        }

        await usersCollection.updateOne(
          { _id: id },
          { $set: { isFraud: true } }
        );

        await ticketsCollection.updateMany(
          { vendorEmail: user.email },
          { $set: { hidden: true } }
        );

        res.send({ success: true });
      }
    );

    // -------------------------------

    console.log("✅ Backend routes registered.");
  } catch (err) {
    console.error("❌ ERROR during run():", err);
  }
}

run().catch(console.error);

app.listen(port, () => {
  console.log(`🔥 Server running on port ${port}`);
});

module.exports = app;
