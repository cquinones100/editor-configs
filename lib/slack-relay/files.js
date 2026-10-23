// Part of bin/slack-relay; see the comment at the top of that file.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { STATE_DIR } = require("./config");
const { log } = require("./util");
const { slack } = require("./slack");
const { uploadFiles } = require("./post");
const { sliced } = require("./slices");
const { lastPrompt } = require("./tabs");

// ── Images and videos you send ──────────────────────────────────────────────

// An image attached to a message you send is downloaded here, readable only
// by you, and its path is added to what is typed into the tab: Claude Code
// reads an image file it is pointed at, so Claude sees the screenshot. Claude
// can't watch a video, so a video is downloaded the same way and FRAMES stills
// spread evenly through it are taken with ffmpeg, and their paths are typed
// after the video's, in order. Only images up to MAX_FILE_BYTES and videos up
// to MAX_VIDEO_BYTES, and only from Slack's own file host, with the bot's
// token. Downloads older than KEEP_FILES_MS are deleted, stills included.
const FILES_DIR = path.join(STATE_DIR, "files");
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const FRAMES = 8;
// Wide enough to read text in a screen recording; a larger video is scaled down.
const FRAME_WIDTH = 1280;
const KEEP_FILES_MS = 7 * 24 * 60 * 60_000;
const FILE_HOST = "files.slack.com";

// A file's own name, cut down to characters that are safe in a path typed
// into a shell-like prompt.
const safeName = (name) => String(name ?? "image").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "image";

const run = promisify(execFile);

// FRAMES stills from a video, evenly spaced from its start, as JPEG files
// beside it, or none if ffmpeg can't read it (or isn't installed).
const framesOf = async (video) => {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { timeout: 30_000 });
    const duration = Number(stdout.trim());
    if (!(duration > 0)) return [];
    const pattern = `${video}-frame-%02d.jpg`;
    await run(
      "ffmpeg",
      ["-v", "error", "-y", "-i", video, "-vf", `fps=${(FRAMES / duration).toFixed(6)},scale='min(${FRAME_WIDTH},iw)':-2`, "-frames:v", String(FRAMES), pattern],
      { timeout: 120_000 },
    );
    return Array.from({ length: FRAMES }, (_, i) => pattern.replace("%02d", String(i + 1).padStart(2, "0"))).filter((frame) => fs.existsSync(frame));
  } catch (err) {
    log(`stills from ${path.basename(video)} failed: ${err.message}`);
    return [];
  }
};

// Downloads one attached file and returns its path, with { frames } for a
// video, or { error } saying why not. An event may carry only the file's ID,
// so the rest is asked of Slack.
const download = async (file) => {
  const info = file.url ? file : await slack.api("files.info", { file: file.id }).then(({ file: f }) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download ?? f.url_private }));
  const video = VIDEO_TYPES.includes(info.mimetype);
  if (!video && !IMAGE_TYPES.includes(info.mimetype)) return { error: `${info.name ?? "That file"} isn't an image or video I can pass on (PNG, JPEG, GIF, WebP, MP4, MOV or WebM).` };
  const kind = video ? "video" : "image";
  const limit = video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (info.size > limit) return { error: `${info.name ?? `That ${kind}`} is larger than ${limit / 1024 / 1024} MB.` };
  let url;
  try {
    url = new URL(info.url);
  } catch {
    return { error: `Slack gave no address for ${info.name ?? `that ${kind}`}.` };
  }
  if (url.protocol !== "https:" || url.hostname !== FILE_HOST) return { error: `${info.name ?? `That ${kind}`} isn't on Slack's file host, so I didn't fetch it.` };
  const bytes = await slack.get(url.href);
  if (bytes.length > limit) return { error: `${info.name ?? `That ${kind}`} is larger than ${limit / 1024 / 1024} MB.` };
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(FILES_DIR, `${safeName(info.id)}-${safeName(info.name)}`);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  log(`${kind}: saved ${info.name} (${bytes.length} bytes)`);
  return video ? { path: target, frames: await framesOf(target) } : { path: target };
};

// Deletes downloads older than KEEP_FILES_MS.
const pruneFiles = () => {
  try {
    fs.readdirSync(FILES_DIR).forEach((name) => {
      const file = path.join(FILES_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > KEEP_FILES_MS) fs.rmSync(file, { force: true });
    });
  } catch {}
};

// ── Images and videos a tab made ────────────────────────────────────────────

// When a turn is posted, the image and video files it made go under it: a
// screenshot or recording Playwright took, a chart Claude saved. Slack shows
// the images and plays the videos in the thread. They are the ones Claude's
// own messages in the turn name, as paths ending in an image or video
// extension: a file only a tool call or its output names was made along the
// way (a probe, a scratch crop), not for you. They are only shared when the
// file really
// is one (by its first bytes), was written during the turn, is under
// MAX_FILE_BYTES (MAX_VIDEO_BYTES for a video), and isn't one you sent. At most
// MAX_SHARED a turn, as many to a message as Slack shows (see uploadFiles).
const MAX_SHARED = 20;
const MEDIA_PATH = /(?:^|[\s"'`(=:[])((?:~|\.{1,2})?\/?[\w@%+.,/-]*\.(?:png|jpe?g|gif|webp|mp4|mov|webm))(?=$|[\s"'`)\],:;!?]|\.(?:\s|$))/gim;

const looksLikeImage = (head) =>
  (head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG") ||
  (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
  head.toString("latin1", 0, 4) === "GIF8" ||
  (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP");

// MP4 and MOV start with a size and "ftyp"; WebM with the Matroska signature.
const looksLikeVideo = (head) =>
  head.toString("latin1", 4, 8) === "ftyp" || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);

const turnMedia = (transcript) => {
  const turn = transcript && lastPrompt(transcript);
  if (!turn || Number.isNaN(turn.sentAt)) return [];
  let cwd = process.cwd();
  // Each of Claude's texts, with the directory the session was in when it
  // said it, so a relative path resolves the way Claude meant it.
  const said = turn.after.flatMap((entry) => {
    if (entry.cwd) cwd = entry.cwd;
    if (entry.type !== "assistant") return [];
    return (Array.isArray(entry.message?.content) ? entry.message.content : []).filter((part) => part.type === "text").map((part) => ({ text: part.text, cwd }));
  });
  const paths = said.flatMap(({ text, cwd: dir }) => [...text.matchAll(MEDIA_PATH)].map((m) => path.resolve(dir, m[1].replace(/^~(?=\/)/, process.env.HOME ?? ""))));
  return [...new Set(paths)]
    .filter((file) => {
      if (file.startsWith(`${FILES_DIR}${path.sep}`)) return false;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.mtimeMs < turn.sentAt - 2_000) return false;
        const fd = fs.openSync(file, "r");
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        if (looksLikeImage(head)) return stat.size <= MAX_FILE_BYTES;
        return looksLikeVideo(head) && stat.size <= MAX_VIDEO_BYTES;
      } catch {
        return false;
      }
    })
    .slice(0, MAX_SHARED);
};

// Uploads the turn's images and videos into `threadTs`, together, a tall
// image as its slices (see slices.js). A failure is only logged: the turn
// itself is already posted.
const shareMedia = async (state, transcript, threadTs) => {
  const files = turnMedia(transcript).flatMap((file) => {
    try {
      return sliced({ filename: path.basename(file), content: fs.readFileSync(file) }).map((part) => ({ ...part, title: part.filename }));
    } catch (err) {
      log(`sharing ${file} failed: ${err.message}`);
      return [];
    }
  });
  if (!files.length) return;
  await uploadFiles(state, files, threadTs, (name, err) => log(`sharing ${name} failed: ${err.message}`))
    .then((names) => names.length && log(`shared ${names.join(", ")}`))
    .catch((err) => log(`sharing failed: ${err.message}`));
};

module.exports = { FILES_DIR, IMAGE_TYPES, VIDEO_TYPES, MAX_FILE_BYTES, MAX_VIDEO_BYTES, FRAMES, KEEP_FILES_MS, FILE_HOST, safeName, framesOf, download, pruneFiles, MAX_SHARED, MEDIA_PATH, looksLikeImage, looksLikeVideo, turnMedia, shareMedia };
