// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR } = require("./config");
const { log } = require("./util");
const { slack } = require("./slack");
const { uploadFile } = require("./post");
const { lastPrompt } = require("./tabs");

// ── Images you send ─────────────────────────────────────────────────────────

// An image attached to a message you send is downloaded here, readable only
// by you, and its path is added to what is typed into the tab: Claude Code
// reads an image file it is pointed at, so Claude sees the screenshot. Only
// images, only up to MAX_FILE_BYTES, and only from Slack's own file host, with
// the bot's token. Downloads older than KEEP_FILES_MS are deleted.
const FILES_DIR = path.join(STATE_DIR, "files");
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const KEEP_FILES_MS = 7 * 24 * 60 * 60_000;
const FILE_HOST = "files.slack.com";

// A file's own name, cut down to characters that are safe in a path typed
// into a shell-like prompt.
const safeName = (name) => String(name ?? "image").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "image";

// Downloads one attached file and returns its path, or { error } saying why
// not. An event may carry only the file's ID, so the rest is asked of Slack.
const download = async (file) => {
  const info = file.url ? file : await slack.api("files.info", { file: file.id }).then(({ file: f }) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download ?? f.url_private }));
  if (!IMAGE_TYPES.includes(info.mimetype)) return { error: `${info.name ?? "That file"} isn't an image I can pass on (PNG, JPEG, GIF or WebP).` };
  if (info.size > MAX_FILE_BYTES) return { error: `${info.name ?? "That image"} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
  let url;
  try {
    url = new URL(info.url);
  } catch {
    return { error: `Slack gave no address for ${info.name ?? "that image"}.` };
  }
  if (url.protocol !== "https:" || url.hostname !== FILE_HOST) return { error: `${info.name ?? "That image"} isn't on Slack's file host, so I didn't fetch it.` };
  const bytes = await slack.get(url.href);
  if (bytes.length > MAX_FILE_BYTES) return { error: `${info.name ?? "That image"} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(FILES_DIR, `${safeName(info.id)}-${safeName(info.name)}`);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  log(`image: saved ${info.name} (${bytes.length} bytes)`);
  return { path: target };
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

// ── Images a tab made ───────────────────────────────────────────────────────

// When a turn is posted, the image files it made go under it: a screenshot
// Playwright took, a chart Claude saved. They are found in what the turn said
// and did (Claude's text, its tool calls and their output), as paths ending in
// an image extension, and only shared when the file is really an image (by
// its first bytes), was written during the turn, is under MAX_FILE_BYTES, and
// isn't one you sent. At most MAX_SHARED a turn.
const MAX_SHARED = 4;
const IMAGE_PATH = /(?:^|[\s"'`(=:[])((?:~|\.{1,2})?\/?[\w@%+.,/-]*\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`)\],:;!?])/gim;

const looksLikeImage = (head) =>
  (head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG") ||
  (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
  head.toString("latin1", 0, 4) === "GIF8" ||
  (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP");

const turnImages = (transcript) => {
  const turn = transcript && lastPrompt(transcript);
  if (!turn || Number.isNaN(turn.sentAt)) return [];
  let cwd = process.cwd();
  const said = turn.after.flatMap((entry) => {
    if (entry.cwd) cwd = entry.cwd;
    return (Array.isArray(entry.message?.content) ? entry.message.content : []).flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "tool_use") return [JSON.stringify(part.input ?? {})];
      if (part.type === "tool_result") return [Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("\n") : String(part.content ?? "")];
      return [];
    });
  });
  const paths = [...new Set(said.flatMap((text) => [...text.replace(/\\n/g, "\n").matchAll(IMAGE_PATH)].map((m) => m[1])))].map((p) =>
    path.resolve(cwd, p.replace(/^~(?=\/)/, process.env.HOME ?? "")),
  );
  return [...new Set(paths)]
    .filter((file) => {
      if (file.startsWith(`${FILES_DIR}${path.sep}`)) return false;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.mtimeMs < turn.sentAt - 2_000) return false;
        const fd = fs.openSync(file, "r");
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        return looksLikeImage(head);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_SHARED);
};

// Uploads the turn's images into `threadTs`. A failure is only logged: the
// turn itself is already posted.
const shareImages = async (state, transcript, threadTs) => {
  for (const file of turnImages(transcript)) {
    await uploadFile(state, { filename: path.basename(file), title: path.basename(file), content: fs.readFileSync(file), threadTs })
      .then(() => log(`image: shared ${path.basename(file)}`))
      .catch((err) => log(`sharing ${file} failed: ${err.message}`));
  }
};

module.exports = { FILES_DIR, IMAGE_TYPES, MAX_FILE_BYTES, KEEP_FILES_MS, FILE_HOST, safeName, download, pruneFiles, MAX_SHARED, IMAGE_PATH, looksLikeImage, turnImages, shareImages };
