// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ujnwtbv.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Collections (will be assigned after connect)
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
    await client.connect();
    console.log("🟢 MongoDB Connected!");

    db = client.db("tixgo_db");
    usersCollection = db.collection("users");
    vendorsCollection = db.collection("vendors");
    ticketsCollection = db.collection("tickets");
    bookingsCollection = db.collection("bookings");
    paymentsCollection = db.collection("payments");

    // ----------------------------------------------------
    // ROOT
    // ----------------------------------------------------
    app.get("/", (req, res) => {
      res.send("Tixgo backend is running! 🚀");
    });

    // || PAYMENT API ||

    // ------------------
    // CREATE TICKET CHECKOUT (Stripe)
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

        // 🚫 Block payment after departure
        const ticket = await ticketsCollection.findOne({
          _id: booking.ticketId,
        });

        if (!ticket) {
          return res.status(404).send({ message: "Ticket not found" });
        }

        if (new Date(ticket.departure) <= new Date()) {
          return res
            .status(400)
            .send({ message: "Departure time passed. Payment not allowed." });
        }

        const totalAmount = booking.price * booking.quantity * 100; // cents

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd", // ✅ Stripe supported
                unit_amount: totalAmount,
                product_data: {
                  name: booking.title,
                },
              },
              quantity: 1,
            },
          ],
          metadata: {
            bookingId: booking._id.toString(),
            ticketId: booking.ticketId.toString(),
            quantity: booking.quantity.toString(),
          },
          success_url: `${process.env.BACKEND_DOMAIN}/stripe/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
        });

        res.send({ url: session.url });
      } catch (err) {
        console.error("Stripe Checkout Error:", err);
        res.status(500).send({ message: err.message });
      }
    });

    // ------------------
    // PAYMENT SUCCESS
    // ------------------
    app.get("/stripe/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
        }

        const bookingId = toObjectId(session.metadata.bookingId);
        const ticketId = toObjectId(session.metadata.ticketId);
        const quantity = parseInt(session.metadata.quantity);

        // Prevent duplicate payment
        const exists = await paymentsCollection.findOne({
          transactionId: session.payment_intent,
        });

        const booking = await bookingsCollection.findOne({ _id: bookingId });
        if (!booking) {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-failed`);
        }

        if (exists) {
          return res.redirect(`${process.env.SITE_DOMAIN}/payment-success`);
        }

        // Update booking status
        await bookingsCollection.updateOne(
          { _id: bookingId },
          { $set: { status: "paid", paidAt: new Date() } }
        );

        // Reduce ticket quantity ONCE (HERE ONLY)
        await ticketsCollection.updateOne(
          { _id: ticketId, quantity: { $gte: quantity } },
          { $inc: { quantity: -quantity } }
        );

        // Save payment record
        await paymentsCollection.insertOne({
          bookingId,
          ticketId,
          customerEmail: booking.customerEmail,
          amount: session.amount_total / 100,
          quantity: booking.quantity,
          currency: session.currency,
          transactionId: session.payment_intent,
          paidAt: new Date(),
        });

        res.redirect(`${process.env.SITE_DOMAIN}/payment-success`);
      } catch (err) {
        console.error("Payment Success Error:", err);
        res.status(500).send({ message: err.message });
      }
    });

    // ------------------
    // Payment Related API
    // ------------------
    app.get("/payments", async (req, res) => {
      try {
        const email = req.query.email;

        const payments = await paymentsCollection
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
                transactionId: 1,
                amount: 1,
                paidAt: 1,
                ticketTitle: "$ticket.title",
              },
            },
            { $sort: { paidAt: -1 } },
          ])
          .toArray();

        res.send(payments);
      } catch (err) {
        console.error("GET /payments error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // ----------------------------------------------------
    // USERS
    // - POST /users        (create user)
    // - GET  /users        (list users)
    // - GET  /users/:email (get user by email)
    // - PUT  /users/:email (update role/profile)
    // ----------------------------------------------------

    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        if (!user?.email)
          return res.status(400).send({ message: "email required" });

        user.role = user.role || "user"; // user | vendor | admin
        user.createdAt = new Date();

        // upsert by email
        const result = await usersCollection.updateOne(
          { email: user.email },
          { $set: user },
          { upsert: true }
        );

        res.send({ success: true, result });
      } catch (err) {
        console.error("POST /users error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/users", async (req, res) => {
      try {
        const q = {};
        if (req.query.role) q.role = req.query.role;
        const users = await usersCollection
          .find(q)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(users);
      } catch (err) {
        console.error("GET /users error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });
        res.send(user);
      } catch (err) {
        console.error("GET /users/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.put("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const update = req.body;
        const result = await usersCollection.updateOne(
          { email },
          { $set: update }
        );
        res.send(result);
      } catch (err) {
        console.error("PUT /users/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // ----------------------------------------------------
    // VENDORS
    // - POST /vendors
    // - GET  /vendors
    // - GET  /vendors/:email
    // - PUT  /vendors/:email
    // ----------------------------------------------------

    app.post("/vendors", async (req, res) => {
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

    app.get("/vendors", async (req, res) => {
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

    app.get("/vendors/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const vendor = await vendorsCollection.findOne({ userEmail: email });
        if (!vendor)
          return res.status(404).send({ message: "Vendor not found" });
        res.send(vendor);
      } catch (err) {
        console.error("GET /vendors/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.put("/vendors/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const update = req.body;
        const result = await vendorsCollection.updateOne(
          { userEmail: email },
          { $set: update },
          { upsert: false }
        );
        res.send(result);
      } catch (err) {
        console.error("PUT /vendors/:email error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // patch ticket vendor
    app.patch("/tickets/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;

        // Prevent forbidden updates
        delete updatedData.verificationStatus;
        delete updatedData.vendorEmail;
        delete updatedData.vendorName;
        delete updatedData.createdAt;

        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!ticket) {
          return res.status(404).send({ message: "Ticket not found" });
        }

        if (ticket.verificationStatus === "rejected") {
          return res.status(403).send({
            message: "Rejected tickets cannot be updated",
          });
        }

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.send({ success: true, modifiedCount: result.modifiedCount });
      } catch (err) {
        console.error("PATCH /tickets/:id error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // ----------------------------------------------------
    // TICKETS
    // - POST /tickets                (vendor create)
    // - GET  /tickets                (filters: verificationStatus, advertised)
    // - GET  /tickets/:id
    // - GET  /tickets/vendor/:email
    // - PATCH /tickets/:id/approve   (admin)
    // - PATCH /tickets/:id/reject    (admin)
    // - PATCH /tickets/:id/advertise (toggle)
    // - PUT  /tickets/:id            (update by vendor)
    // - DELETE /tickets/:id
    // - GET  /tickets/advertised?limit=N
    // ----------------------------------------------------

    // Create ticket (vendor)
    app.post("/tickets", async (req, res) => {
      try {
        const ticket = req.body;
        if (!ticket?.vendorEmail)
          return res.status(400).send({ message: "vendorEmail required" });
        ticket.verificationStatus = "pending";
        ticket.advertised = false;
        ticket.createdAt = ticket.createdAt
          ? new Date(ticket.createdAt)
          : new Date();

        const result = await ticketsCollection.insertOne(ticket);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (err) {
        console.error("POST /tickets error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get tickets with optional filters
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

    // GET advertised tickets (max limit)
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

    // Get tickets by vendor email
    app.get("/tickets/vendor/:email", async (req, res) => {
      try {
        const email = req.params.email;
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

    // Get single ticket
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

    // Approve ticket (admin)
    app.patch("/tickets/:id/approve", async (req, res) => {
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
    });

    // Reject ticket (admin)
    app.patch("/tickets/:id/reject", async (req, res) => {
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
    });

    // Advertise toggle: set advertised to true/false (server enforces <=6 advertised approved tickets)
    app.patch("/tickets/:id/advertise", async (req, res) => {
      try {
        const id = req.params.id;
        const { advertised } = req.body;
        if (typeof advertised !== "boolean")
          return res
            .status(400)
            .send({ message: "advertised must be boolean" });

        // If turning ON, enforce max 6 advertised + approved tickets
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
    });

    // Update ticket (vendor)
    app.put("/tickets/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const update = req.body;
        const oid = toObjectId(id);
        if (!oid) return res.status(400).send({ message: "invalid id" });

        const result = await ticketsCollection.updateOne(
          { _id: oid },
          { $set: update }
        );
        res.send(result);
      } catch (err) {
        console.error("PUT /tickets/:id error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Delete ticket
    app.delete("/tickets/:id", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const ticket = await ticketsCollection.findOne({ _id: id });

      if (!ticket) {
        return res.status(404).send({ message: "Ticket not found" });
      }

      if (ticket.verificationStatus === "rejected") {
        return res.status(403).send({
          message: "Rejected tickets cannot be deleted",
        });
      }

      const result = await ticketsCollection.deleteOne({ _id: id });
      res.send(result);
    });

    // // Get advertised tickets (homepage)
    // app.get("/tickets/advertised", async (req, res) => {
    //   try {
    //     const limit = parseInt(req.query.limit) || 6;
    //     const result = await ticketsCollection
    //       .find({ verificationStatus: "approved", advertised: true })
    //       .sort({ createdAt: -1 })
    //       .limit(limit)
    //       .toArray();
    //     res.send(result);
    //   } catch (err) {
    //     console.error("GET /tickets/advertised error:", err);
    //     res.status(500).send({ message: "Server error" });
    //   }
    // });

    // ----------------------------------------------------
    // BOOKINGS
    // - POST /bookings      (create a booking, validate qty, reduce ticket quantity, status: pending)
    // - GET  /bookings?email=... (user bookings)
    // ----------------------------------------------------

    app.post("/bookings", async (req, res) => {
      try {
        const booking = req.body;
        if (
          !booking?.ticketId ||
          !booking?.quantity ||
          !booking?.customerEmail
        ) {
          return res
            .status(400)
            .send({ message: "ticketId, quantity and customerEmail required" });
        }

        const ticketOid = toObjectId(booking.ticketId);
        if (!ticketOid)
          return res.status(400).send({ message: "invalid ticketId" });

        // Fetch ticket
        const ticket = await ticketsCollection.findOne({ _id: ticketOid });
        if (!ticket)
          return res.status(404).send({ message: "Ticket not found" });

        // only allow booking if ticket is approved
        if (ticket.verificationStatus !== "approved") {
          return res
            .status(400)
            .send({ message: "Ticket is not approved for booking" });
        }

        if (ticket.quantity < booking.quantity) {
          return res
            .status(400)
            .send({ message: "Not enough tickets available" });
        }

        // ❌ NO STOCK REDUCTION HERE

        booking.ticketId = ticket._id;
        booking.vendorEmail = ticket.vendorEmail;
        booking.title = ticket.title;
        booking.price = ticket.price;
        booking.status = "pending";
        booking.createdAt = new Date();

        const insert = await bookingsCollection.insertOne(booking);
        res.send({ success: true, bookingId: insert.insertedId });
      } catch (err) {
        console.error("POST /bookings error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get user bookings
    app.get("/bookings", async (req, res) => {
      try {
        const email = req.query.email;

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

    // Vendor accepts booking
    app.patch("/bookings/:id/accept", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const result = await bookingsCollection.updateOne(
        { _id: id, status: "pending" },
        { $set: { status: "accepted", acceptedAt: new Date() } }
      );

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    // Vendor rejects booking
    app.patch("/bookings/:id/reject", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const result = await bookingsCollection.updateOne(
        { _id: id, status: "pending" },
        { $set: { status: "rejected", rejectedAt: new Date() } }
      );

      res.send({ success: true, modifiedCount: result.modifiedCount });
    });

    // Get booking requests for vendor
    // Get booking requests for vendor
    app.get("/bookings/vendor/:email", async (req, res) => {
      try {
        const vendorEmail = req.params.email;

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

    // ----------------------------------------------------
    // ADMIN/stats              → users, vendors, tickets, bookings
    // admin/revenue-overview   → revenue cards
    // admin/revenue-chart      → charts
    // admin/vendors/pending    → vendor approval
    // ----------------------------------------------------

    app.get("/admin/profile", async (req, res) => {
      try {
        // later this email will come from JWT
        const email = req.decoded?.email || req.query.email;

        if (!email) {
          return res.status(401).send({ message: "Unauthorized" });
        }

        const admin = await usersCollection.findOne({ email });

        if (!admin || admin.role !== "admin") {
          return res.status(403).send({ message: "Forbidden" });
        }

        res.send({
          name: admin.name,
          email: admin.email,
          role: admin.role,
          image: admin.image,
          phone: admin.phone,
          joined: admin.createdAt,
        });
      } catch (error) {
        console.error("GET /admin/profile error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/admin/stats", async (req, res) => {
      try {
        const usersCount = await usersCollection.countDocuments();
        const vendorsCount = await vendorsCollection.countDocuments();
        const ticketsCount = await ticketsCollection.countDocuments();
        const bookingsCount = await bookingsCollection.countDocuments();
        res.send({ usersCount, vendorsCount, ticketsCount, bookingsCount });
      } catch (err) {
        console.error("GET /admin/stats error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/admin/vendors/pending", async (req, res) => {
      try {
        const pending = await vendorsCollection
          .find({ verified: false })
          .toArray();
        res.send(pending);
      } catch (err) {
        console.error("GET /admin/vendors/pending error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.patch("/admin/vendors/:email/verify", async (req, res) => {
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
    });

    app.get("/admin/revenue-overview", async (req, res) => {
      try {
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
      } catch (err) {
        console.error("GET /admin/revenue-overview error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/admin/revenue-chart", async (req, res) => {
      try {
        const chartData = await paymentsCollection
          .aggregate([
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$paidAt" },
                },
                revenue: { $sum: "$amount" },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray();

        res.send(chartData);
      } catch (err) {
        console.error("GET /admin/revenue-chart error:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/admin/users", async (req, res) => {
      try {
        const users = await usersCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    app.patch("/admin/users/:id/make-admin", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const result = await usersCollection.updateOne(
        { _id: id },
        { $set: { role: "admin" } }
      );

      res.send({ success: true });
    });

    app.patch("/admin/users/:id/make-vendor", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const result = await usersCollection.updateOne(
        { _id: id },
        { $set: { role: "vendor", isFraud: false } }
      );

      res.send({ success: true });
    });

    app.patch("/admin/users/:id/mark-fraud", async (req, res) => {
      const id = toObjectId(req.params.id);
      if (!id) return res.status(400).send({ message: "Invalid id" });

      const user = await usersCollection.findOne({ _id: id });
      if (!user || user.role !== "vendor") {
        return res.status(400).send({ message: "Not a vendor" });
      }

      // 1. Mark user as fraud
      await usersCollection.updateOne({ _id: id }, { $set: { isFraud: true } });

      // 2. Hide all vendor tickets
      await ticketsCollection.updateMany(
        { vendorEmail: user.email },
        { $set: { hidden: true } }
      );

      res.send({ success: true });
    });

    // --------------------------------

    console.log("✅ Backend routes registered.");
  } catch (err) {
    console.error("❌ ERROR during run():", err);
    process.exit(1);
  }
}

run().catch(console.error);

// Start server
app.listen(port, () => {
  console.log(`🔥 Server running on port ${port}`);
});
