require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const path = require("path");
const PORT = process.env.PORT || 3978;

const app = express();

app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.static(path.join(__dirname, "dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.json());

/* ------------------- AUTH START ------------------- */

app.get("/auth-start", (req, res) => {
  const redirectUri = `https://${req.headers.host}/auth-callback`;

  const url =
    `https://${process.env.AUTH0_DOMAIN}/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.AUTH0_CLIENT_ID}` +
    `&redirect_uri=${redirectUri}` +
    `&scope=openid profile email offline_access` +
    `&connection=azuread`;

  res.redirect(url);
});

/* ------------------- AUTH CALLBACK ------------------- */

app.get("/auth-callback", async (req, res) => {
  const { code } = req.query;

  const tokenRes = await fetch(
    `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        code,
        redirect_uri: `https://${req.headers.host}/auth-callback`,
      }),
    },
  );

  const tokenData = await tokenRes.json();

  res.send(`
    <script>
      window.opener.postMessage(
        { type: "AUTH_SUCCESS", token: ${JSON.stringify(tokenData)} },
        "*"
      );
      window.close();
    </script>
  `);
});

/* ------------------- VERIFY TOKEN ------------------- */

const client = jwksClient({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, function (err, key) {
    callback(null, key.getPublicKey());
  });
}

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  jwt.verify(
    token,
    getKey,
    {
      audience: process.env.AUTH0_CLIENT_ID,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) return res.status(401).json({ error: "Invalid token" });
      req.user = decoded;
      next();
    },
  );
}

app.get("/api/profile", verifyToken, (req, res) => {
  res.json({
    message: "Token Valid",
    user: req.user,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
