const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.send("Tixgoooooo!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
