# 🎟️ TixGo – Online Ticket Booking Platform (Backend)

## 📌 Project Name
**Online Ticket Booking Platform**

## 🌐 Website Name
**TixGo**

## 🔗 Live Website
https://tixgo.netlify.app/


---

## 🧭 Project Overview

**TixGo** is a full-featured **Online Ticket Booking Platform** built using the **MERN stack**.  
It allows users to discover, book, and pay for travel tickets such as **Bus, Train, Launch, and Plane**.

The platform supports **three roles**:
- **User** – Browse, book, and pay for tickets
- **Vendor** – Create and manage tickets
- **Admin** – Control users, vendors, tickets, and platform revenue

This repository contains the **backend API** built with **Node.js, Express, MongoDB, Firebase Admin, and Stripe**.

---

## 🧑‍💼 User Roles & Permissions

### 👤 User
- Register/Login using Firebase Authentication
- Browse approved tickets
- Book tickets
- Make secure payments via Stripe
- View booking history
- View payment history

### 🏷️ Vendor
- Apply for vendor account
- Create travel tickets
- Update tickets (if not rejected)
- Accept or reject bookings
- View vendor revenue overview
- Vendor fraud protection system

### 🛡️ Admin
- Approve or reject vendor applications
- Approve, reject, advertise tickets
- Limit advertised tickets (max 6)
- Manage users and roles
- Mark vendors as fraud (auto-hide tickets)
- View platform statistics
- View revenue analytics & charts

---

## ⭐ Key Features

- 🔐 Firebase Authentication with JWT verification
- 🧾 Role-based authorization (User / Vendor / Admin)
- 🎫 Ticket booking & inventory management
- 💳 Secure Stripe payment integration
- 📊 Revenue analytics for Admin & Vendor
- 📢 Ticket advertisement system
- 🚫 Fraud detection & vendor suspension
- ⚡ MongoDB indexing for performance
- 🌍 CORS-secured production-ready API

---

## Backend npm Packages Used

- **Node.js**
- **Express.js**
- **MongoDB**
- **Firebase Admin SDK**
- **Stripe API**

