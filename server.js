require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3978;

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* =========================================================
   AUTH START → Redirect to Auth0
========================================================= */

app.get("/auth-start", (req, res) => {
  const { AUTH0_CLIENT_ID, AUTH0_AUDIENCE, AUTH0_DOMAIN, API_BASE_URL } =
    process.env;

  if (!AUTH0_CLIENT_ID || !AUTH0_DOMAIN || !API_BASE_URL) {
    return res.status(500).send("Missing Auth0 environment variables");
  }

  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${API_BASE_URL}/auth-callback`,
    scope: "openid profile email offline_access",
    connection: "azuread", // Force Azure Enterprise login
    prompt: "none",
  });

  if (AUTH0_AUDIENCE) {
    params.append("audience", AUTH0_AUDIENCE);
  }

  const authUrl = `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
  return res.redirect(authUrl);
});

/* =========================================================
   AUTH CALLBACK → Return code to Teams popup
========================================================= */

app.get("/auth-callback", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;

  if (!code) return res.status(400).send("Missing code");

  res.setHeader("Content-Type", "text/html");

  return res.end(`
    <script src="https://res.cdn.office.net/teams-js/2.40.0/js/MicrosoftTeams.min.js"></script>
    <script>
      microsoftTeams.app.initialize().then(() => {
        microsoftTeams.authentication.notifySuccess("${code}");
      });
    </script>
  `);
});

/* =========================================================
   EXCHANGE AUTH0 TOKEN (Backend secure exchange)
========================================================= */

app.post("/exchange-auth0-token", async (req, res) => {
  try {
    const code = typeof req.body?.code === "string" ? req.body.code : null;

    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    const {
      AUTH0_CLIENT_ID,
      AUTH0_CLIENT_SECRET,
      AUTH0_DOMAIN,
      AUTH0_AUDIENCE,
      API_BASE_URL,
    } = process.env;

    if (
      !AUTH0_CLIENT_ID ||
      !AUTH0_CLIENT_SECRET ||
      !AUTH0_DOMAIN ||
      !API_BASE_URL
    ) {
      return res
        .status(500)
        .json({ error: "Missing Auth0 environment variables" });
    }

    const payload = {
      grant_type: "authorization_code",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: `${API_BASE_URL}/auth-callback`,
    };

    if (AUTH0_AUDIENCE) {
      payload.audience = AUTH0_AUDIENCE;
    }

    const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Token exchange failed:", tokenData);
      return res.status(500).json({ error: "Token exchange failed" });
    }

    return res.json(tokenData);
  } catch (err) {
    console.error("Exchange token error:", err);
    return res.status(500).json({ error: "Token exchange failed" });
  }
});

/* =========================================================
   REFRESH TOKEN
========================================================= */

app.post("/refresh-auth0-token", async (req, res) => {
  try {
    const refreshToken =
      typeof req.body?.refresh_token === "string"
        ? req.body.refresh_token
        : null;

    if (!refreshToken) {
      return res.status(400).json({ error: "Missing refresh_token" });
    }

    const {
      AUTH0_CLIENT_ID,
      AUTH0_CLIENT_SECRET,
      AUTH0_DOMAIN,
      AUTH0_AUDIENCE,
    } = process.env;

    if (!AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET || !AUTH0_DOMAIN) {
      return res
        .status(500)
        .json({ error: "Missing Auth0 environment variables" });
    }

    const payload = {
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      refresh_token: refreshToken,
    };

    if (AUTH0_AUDIENCE) {
      payload.audience = AUTH0_AUDIENCE;
    }

    const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Refresh failed:", tokenData);
      return res.status(500).json({ error: "Refresh failed" });
    }

    return res.json(tokenData);
  } catch (err) {
    console.error("Refresh token error:", err);
    return res.status(500).json({ error: "Refresh failed" });
  }
});

/* =========================================================
   VERIFY AUTH0/AZURE(SSO) ACCESS TOKEN
========================================================= */

const azureJwksClient = jwksClient({
  jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
});

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
  if (!token) return res.status(401).json({ error: "Missing token" });

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.payload) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const issuer = decoded.payload.iss;
  console.log("Decoded issuer:", issuer);

  // Azure Token
  if (
    issuer &&
    (issuer.startsWith("https://login.microsoftonline.com/") ||
      issuer.startsWith("https://sts.windows.net/"))
  ) {
    return jwt.verify(
      token,
      (header, callback) => {
        azureJwksClient.getSigningKey(header.kid, (err, key) => {
          callback(null, key.getPublicKey());
        });
      },
      {
        audience: process.env.AZURE_AUDIENCE,
        algorithms: ["RS256"],
      },
      (err, verified) => {
        if (err) {
          console.error("Azure verify error:", err);
          return res.status(401).json({ error: "Invalid Azure token" });
        }

        req.user = {
          provider: "azure",
          oid: verified.oid,
          tid: verified.tid,
          email:
            verified.preferred_username || verified.upn || verified.unique_name,
        };

        next();
      },
    );
  }

  // Auth0 Token
  if (issuer?.includes(process.env.AUTH0_DOMAIN)) {
    return jwt.verify(
      token,
      (header, callback) => {
        client.getSigningKey(header.kid, (err, key) => {
          callback(null, key.getPublicKey());
        });
      },
      {
        audience: process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID,
        issuer: `https://${process.env.AUTH0_DOMAIN}/`,
        algorithms: ["RS256"],
      },
      (err, verified) => {
        if (err) return res.status(401).json({ error: "Invalid Auth0 token" });

        req.user = {
          provider: "auth0",
          ...verified,
        };

        next();
      },
    );
  }

  return res.status(401).json({ error: "Unknown token issuer" });
}

/* =========================================================
   LOGOUT from AUTH0
========================================================= */
app.get("/logout-start", (req, res) => {
  const { AUTH0_DOMAIN, AUTH0_CLIENT_ID, API_BASE_URL } = process.env;

  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    returnTo: `${API_BASE_URL}/logout-callback`,
  });

  const logoutUrl = `https://${AUTH0_DOMAIN}/v2/logout?${params.toString()}`;
  res.redirect(logoutUrl);
});

app.get("/logout-callback", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`
    <script src="https://res.cdn.office.net/teams-js/2.40.0/js/MicrosoftTeams.min.js"></script>
    <script>
      microsoftTeams.app.initialize().then(() => {
        microsoftTeams.authentication.notifySuccess("logout-success");
      });
    </script>
  `);
});

/* =========================================================
   SAMPLE PROTECTED API
========================================================= */

app.get("/api/profile", verifyToken, (req, res) => {
  res.json({
    message: "Token valid",
    user: req.user,
  });
});

/* =========================================================
   STATIC REACT APP (MUST BE LAST)
========================================================= */

app.use(express.static(path.join(__dirname, "dist")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

/* ========================================================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
