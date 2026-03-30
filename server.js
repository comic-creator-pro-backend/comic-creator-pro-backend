import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DATA_DIR = path.join(__dirname, "data");
const IMAGE_DIR = path.join(__dirname, "public", "generated");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(IMAGE_DIR));

const rateBucket = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = rateBucket.get(ip) || { count: 0, start: now };

  if (now - record.start > RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ip, { count: 1, start: now });
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({
      ok: false,
      error: "Too many requests. Please try again shortly.",
    });
  }

  record.count += 1;
  rateBucket.set(ip, record);
  next();
}

function sanitizeText(value, maxLength = 1500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validateScenePayload(body) {
  const payload = {
    projectName: sanitizeText(body.projectName, 120),
    theme: sanitizeText(body.theme, 120),
    sceneTitle: sanitizeText(body.sceneTitle, 120),
    caption: sanitizeText(body.caption, 1500),
    dialogue: sanitizeText(body.dialogue, 500),
    style: sanitizeText(body.style, 120),
    size: sanitizeText(body.size, 20) || "1024x1024",
    sceneId: sanitizeText(body.sceneId, 120) || crypto.randomUUID(),
  };

  if (!payload.sceneTitle) {
    return { ok: false, error: "sceneTitle is required." };
  }

  if (!payload.caption && !payload.dialogue) {
    return { ok: false, error: "caption or dialogue is required." };
  }

  const allowedSizes = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  if (!allowedSizes.has(payload.size)) {
    return { ok: false, error: "Invalid image size." };
  }

  return { ok: true, payload };
}

function buildImagePrompt({ projectName, theme, sceneTitle, caption, dialogue, style }) {
  return [
    "Create polished comic artwork for a comic video app.",
    `Project: ${projectName || "Untitled Project"}`,
    `Theme: ${theme || "Cinematic Pop"}`,
    `Scene title: ${sceneTitle}`,
    `Narration: ${caption || "None"}`,
    `Dialogue bubble text: ${dialogue || "None"}`,
    `Character style: ${style || "Hero"}`,
    "Look dynamic, colorful, cinematic, high-detail, and suitable for a mobile comic-video editor.",
    "Keep the composition clean and readable for text overlays.",
  ].join("\n");
}

async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  try {
    await fs.access(PROJECTS_FILE);
  } catch {
    await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects: [] }, null, 2), "utf8");
  }
}

async function readProjects() {
  await ensureDirectories();
  const raw = await fs.readFile(PROJECTS_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeProjects(data) {
  await ensureDirectories();
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function saveGeneratedImage(base64Data, filename) {
  await ensureDirectories();
  const filepath = path.join(IMAGE_DIR, filename);
  const buffer = Buffer.from(base64Data, "base64");
  await fs.writeFile(filepath, buffer);
  return `/generated/${filename}`;
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "comic-creator-pro-backend",
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/projects", async (_req, res) => {
  try {
    const data = await readProjects();
    res.json({ ok: true, projects: data.projects || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/projects", rateLimit, async (req, res) => {
  try {
    const project = req.body;
    if (!project || typeof project !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid project payload." });
    }

    const data = await readProjects();
    const record = {
      id: project.id || crypto.randomUUID(),
      name: sanitizeText(project.name, 120) || "Untitled Project",
      theme: sanitizeText(project.theme, 120),
      voiceStyle: sanitizeText(project.voiceStyle, 120),
      musicTrack: sanitizeText(project.musicTrack, 120),
      scenes: Array.isArray(project.scenes) ? project.scenes : [],
      createdAt: project.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = data.projects.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      data.projects[existingIndex] = { ...data.projects[existingIndex], ...record };
    } else {
      data.projects.unshift(record);
    }

    await writeProjects(data);
    res.json({ ok: true, project: record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/generate-scene-image", rateLimit, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is missing on the server." });
    }

    const validation = validateScenePayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ ok: false, error: validation.error });
    }

    const payload = validation.payload;
    const prompt = buildImagePrompt(payload);

    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: payload.size,
    });

    const imageBase64 = response.data?.[0]?.b64_json;
    if (!imageBase64) {
      return res.status(502).json({ ok: false, error: "Image API returned no image data." });
    }

    const filename = `${payload.sceneId}-${Date.now()}.png`;
    const imageUrl = await saveGeneratedImage(imageBase64, filename);

    res.json({
      ok: true,
      imageUrl,
      promptUsed: prompt,
      provider: "OpenAI",
      model: "gpt-image-1",
      sceneId: payload.sceneId,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = error?.status || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Image generation failed.",
    });
  }
});

app.post("/api/generate-all-scenes", rateLimit, async (req, res) => {
  try {
    const scenes = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
    if (scenes.length === 0) {
      return res.status(400).json({ ok: false, error: "scenes array is required." });
    }

    const results = [];

    for (const scene of scenes) {
      const validation = validateScenePayload(scene);
      if (!validation.ok) {
        results.push({
          ok: false,
          sceneTitle: scene?.sceneTitle || "Unknown",
          error: validation.error,
        });
        continue;
      }

      try {
        const payload = validation.payload;
        const prompt = buildImagePrompt(payload);

        const response = await openai.images.generate({
          model: "gpt-image-1",
          prompt,
          size: payload.size,
        });

        const imageBase64 = response.data?.[0]?.b64_json;
        if (!imageBase64) {
          results.push({
            ok: false,
            sceneTitle: payload.sceneTitle,
            error: "No image data returned.",
          });
          continue;
        }

        const filename = `${payload.sceneId}-${Date.now()}.png`;
        const imageUrl = await saveGeneratedImage(imageBase64, filename);

        results.push({
          ok: true,
          sceneId: payload.sceneId,
          sceneTitle: payload.sceneTitle,
          imageUrl,
          promptUsed: prompt,
        });
      } catch (sceneError) {
        results.push({
          ok: false,
          sceneTitle: scene?.sceneTitle || "Unknown",
          error: sceneError?.message || "Failed for this scene.",
        });
      }
    }

    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

ensureDirectories()
  .then(() => {
    app.listen(port, () => {
      console.log(`Comic Creator Pro backend running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Startup error:", error);
    process.exit(1);
  });
