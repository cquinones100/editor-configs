// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tryTmux } = require("./util");
const { transcriptFor, paneFor } = require("./tabs");

// ── Skills ──────────────────────────────────────────────────────────────────

// Slack takes any message starting with "/" for one of its own commands and
// never sends it, so a skill can't be typed into a thread as it is at the
// keyboard. The tab's screen and the buttons under a finished turn offer a
// Skill form instead: a menu of the skills that tab can run, and a field for
// what follows the name (see screens.js). The menu is the tab's own:
//
// - the skills its session was told about, which Claude Code writes into the
//   transcript as `skill_listing` attachments: the whole list when the session
//   starts, then any added since;
// - skills only you can invoke, which that list leaves out, from the skill and
//   command folders Claude Code reads: yours in ~/.claude, and the project's
//   in .claude in the tab's directory and the directories above it.
//
// A Slack menu holds at most 100 options, and a project can have more skills
// than that, so each skill says where it came from: yours first, then the
// project's, then everything else the session lists (plugins and built-in
// ones), which is where a long list is cut. The form has a field for a name
// the menu left out.

const SKILL_NAME = /^[\w.-]+(?::[\w.-]+)?$/;
const MAX_SKILLS = 100; // a Slack menu holds at most 100 options
const SOURCES = ["yours", "project", "session"];

const oneLine = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// A skill or command file's description, from its front matter.
const describe = (file) => {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 4000);
    const front = head.startsWith("---") ? head.slice(3, head.indexOf("\n---", 3)) : "";
    return front.match(/^description:\s*(.+)$/m)?.[1].replace(/^["'>|-]\s*|["']$/g, "") ?? "";
  } catch {
    return "";
  }
};

// The .claude folders that apply to a directory: its own and its parents',
// up to (not including) your home, which is read as yours.
const projectFolders = (dir) => {
  const home = os.homedir();
  const folders = [];
  for (let at = dir; at && at !== home && at !== path.dirname(at); at = path.dirname(at)) folders.push(path.join(at, ".claude"));
  return folders;
};

// What a tab can run, as [{ name, description, source }]: yours, then the
// project's, then the rest, each sorted by name.
const skillsFor = (tab) => {
  const found = new Map();
  const add = (name, description, source) => {
    if (!SKILL_NAME.test(name)) return;
    const known = found.get(name);
    if (!known) found.set(name, { description: oneLine(description, 150), source });
    else if (!known.description) known.description = oneLine(description, 150);
  };

  const dir = tryTmux(["display-message", "-p", "-t", paneFor(tab.id), "#{pane_current_path}"]);
  [[path.join(os.homedir(), ".claude"), "yours"], ...(dir ? projectFolders(dir) : []).map((folder) => [folder, "project"])].forEach(([folder, source]) => {
    const read = (sub) => {
      try {
        return fs.readdirSync(path.join(folder, sub), { withFileTypes: true });
      } catch {
        return [];
      }
    };
    read("skills").forEach((entry) => {
      const skill = path.join(folder, "skills", entry.name, "SKILL.md");
      if (fs.existsSync(skill)) add(entry.name, describe(skill), source);
    });
    read("commands").filter((entry) => entry.name.endsWith(".md")).forEach((entry) => add(entry.name.slice(0, -3), describe(path.join(folder, "commands", entry.name)), source));
  });

  const file = transcriptFor(tab.id, tab.pid);
  let listed = [];
  try {
    fs.readFileSync(file, "utf8").split("\n").forEach((line) => {
      if (!line.includes('"skill_listing"')) return;
      const attachment = JSON.parse(line).attachment;
      if (attachment?.type !== "skill_listing") return;
      const described = new Map([...String(attachment.content ?? "").matchAll(/^- (\S+?)(?: \([^)\n]*\))?: (.*)$/gm)].map((m) => [m[1], m[2]]));
      const entries = (attachment.names ?? [...described.keys()]).map((name) => [name, described.get(name) ?? ""]);
      listed = attachment.isInitial ? entries : [...listed, ...entries];
    });
  } catch {}
  listed.forEach(([name, description]) => add(name, description, "session"));

  return [...found]
    .map(([name, { description, source }]) => ({ name, description, source }))
    .sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.name.localeCompare(b.name));
};

module.exports = { SKILL_NAME, MAX_SKILLS, SOURCES, skillsFor };
