import express from "express";
import axios from "axios";
import "dotenv/config";
import { ClientSecretCredential } from "@azure/identity";

const app = express();
app.use(express.json());

const {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  PORT = 4000,
} = process.env;

// 1) Token helper (app-only)
async function getGraphToken() {
  const credential = new ClientSecretCredential(
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
  );
  const scope = "https://graph.microsoft.com/.default";
  const accessToken = await credential.getToken(scope);
  return accessToken.token;
}

const TEAMS_APP_ID = "c1d5415e-39ba-4bb6-9edb-5bace36d122f"; // manifest id
const TAB_ENTITY_ID = "96dc8804-6fd5-4bbd-97ae-1e85e07b2404"; // static tab entityId

function buildTeamsDeepLink(notificationId) {
  const context = {
    subEntityId: notificationId,
    page: "redirect",
  };

  return `https://teams.microsoft.com/l/entity/${TEAMS_APP_ID}/${TAB_ENTITY_ID}?context=${encodeURIComponent(
    JSON.stringify(context),
  )}`;
}

/**
 * 2) Send an activity feed notification to a single user
 * Docs endpoint:
 * POST /users/{userId|UPN}/teamwork/sendActivityNotification
 */
async function sendActivityNotificationToUser({
  userIdOrUpn,
  title,
  notificationId,
}) {
  const token = await getGraphToken();

  const teamsDeepLink = buildTeamsDeepLink(notificationId);

  const body = {
    topic: {
      source: "text",
      value: "Izola",
      webUrl: teamsDeepLink, // ✅ valid /l/ deep link
    },
    activityType: "alert",
    previewText: {
      content: title.slice(0, 150),
    },
    templateParameters: [{ name: "title", value: title }],
  };

  const endpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
    userIdOrUpn,
  )}/teamwork/sendActivityNotification`;

  await axios.post(endpoint, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}
/**
 * 3) Example API: call this with a user + your notification payload
 * POST /notify-user
 * {
 *   "user": "user@forrester.com",
 *   "notifications": [{ "title": "...", "url": "..." }, ...]
 * }
 */
app.post("/notify-user", async (req, res) => {
  try {
    const { user, notifications } = req.body;
    console.log("Received notify-user request for", user, notifications);
    if (!user || !Array.isArray(notifications) || notifications.length === 0) {
      return res
        .status(400)
        .json({ error: "Provide { user, notifications[] }" });
    }

    // Send one activity per notification (simple + matches your data model)
    // You can also batch later using Graph bulk recipients if needed. :contentReference[oaicite:4]{index=4}
    for (const n of notifications) {
      if (!n?.title || !n?.url) continue;
      await sendActivityNotificationToUser({
        userIdOrUpn: user,
        title: n.title,
        notificationId: n.id, // ✅ this fixes everything
      });
    }

    res.json({ ok: true, sent: notifications.length });
  } catch (err) {
    console.error("GRAPH ERROR STATUS:", err);
    console.error(
      "GRAPH ERROR DATA:",
      JSON.stringify(err?.response?.data, null, 2),
    );

    res.status(500).json({
      error: "Failed to send activity notification",
      status: err?.response?.status,
      data: err?.response?.data,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
