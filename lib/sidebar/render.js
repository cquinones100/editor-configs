// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Frames for the sidebar and mission control: plain functions from what is
// known to the lines to draw, so the tests can read them.

const os = require("node:os");
const { grouped, staged } = require("./model");
const { lastTurn, transcriptFor } = require("./claude");
const { width, cut, pad, wrap, plain, fg, bg, BOLD, RESET, STATES, SPINNER, theme, ago } = require("./text");

const home = os.homedir();
// The most lines a tab's name wraps to in the sidebar.
const NAME_LINES = 3;
const tilde = (dir) => (dir && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir ?? "");

// The state a tab's badge shows: Claude's, or, for an idle tab, its PR's
// place in the merge queue or that it merged.
const badgeState = (tab) =>
  tab.flagged && tab.state !== "waiting" && tab.state !== "done" ? "flagged"
  : tab.state === "idle" && tab.merge ? tab.merge
  : tab.state === "background" && tab.loop ? tab.loop.kind
  : (tab.state === "working" || tab.state === "background") && tab.loopSkill ? tab.loopSkill
  : tab.state;

// The state mark: a colored pill, the spinner turning while Claude works.
const badge = (state, frame) => {
  const s = STATES[state];
  if (!s.color) return `${fg(theme().faint)} ${s.mark} ${RESET}`;
  const mark = ["working", "background", "review", "ci", "queue"].includes(state) ? SPINNER[frame % SPINNER.length] : s.mark;
  return `${bg(s.color)}${fg(s.ink)}${BOLD} ${mark} ${RESET}`;
};

// What a tab is doing, in words: "waiting on you 4m", "finished 2m ago", and
// where its PR is: "in merge queue at 3", "merged".
const mergeWords = (tab) => (tab.merge === "queued" ? `in merge queue${tab.position ? ` at ${tab.position}` : ""}` : tab.merge === "merged" ? "merged" : "");
const stateWords = (tab) => {
  const words = stateOnly(tab);
  return tab.flagged ? ["flagged", words].filter(Boolean).join(" · ") : words;
};
const stateOnly = (tab) => {
  const since = ago(tab.since);
  const merge = mergeWords(tab);
  const and = (words) => [words, merge].filter(Boolean).join(" · ");
  if (tab.state === "waiting") return and([`waiting on you${since ? ` ${since}` : ""}`, tab.wait].filter(Boolean).join(" · "));
  if (tab.state === "done") return and(`finished${since ? ` ${since} ago` : ""}`);
  if (tab.state === "working") return and([`working${since ? ` ${since}` : ""}`, tab.loopSkill && STATES[tab.loopSkill]?.words, tab.activity].filter(Boolean).join(" · "));
  if (tab.state === "background" && tab.loop) return and(tab.loop.kind === "queue" ? "queue-and-clean · watching" : `${STATES[tab.loop.kind].words} · round ${tab.loop.round}`);
  if (tab.state === "background") return and(`working in background · ${tab.background} task${tab.background === 1 ? "" : "s"}`);
  if (merge) return merge;
  const command = tab.claude ? "claude" : tab.command ?? "";
  return since ? `idle for ${since} · ${command}` : command;
};

const counts = (tabs, p) =>
  ["waiting", "done", "working"]
    // Working counts the tabs working in the background, a loop's too.
    .map((state) => [state, tabs.filter((t) => t.state === state || (state === "working" && t.state === "background")).length])
    .filter(([, n]) => n)
    .map(([state, n]) => `${fg(STATES[state].color)}${BOLD}${STATES[state].mark === "⠋" ? "⋯" : STATES[state].mark} ${n}${RESET}`)
    .join(`${fg(p.faint)}  `);

// The sidebar for one window: its session's tabs, most in need of you first,
// then each plugin's short list. `view` is { focused, cursor, frame, here },
// where here is the window the sidebar sits in and cursor the window chosen
// with j/k while it has focus. Returns the lines, and for each the window it
// belongs to, for a mouse click.
const sidebarLines = ({ tabs, sections, cols, rows, view }) => {
  const p = theme();
  const lines = [];
  const owners = [];
  let cursorAt = 0;
  let cursorEnd = 0;
  const selected = view.focused ? view.cursor : view.here;
  const here = tabs.find((t) => t.id === view.here);
  const pill = here?.color ? `${bg(here.color)}${fg(232)}${BOLD}` : `${bg(p.highlight)}${fg(p.bright)}${BOLD}`;
  lines.push(pad(` ${pill} ${here?.sessionName ?? ""} ${RESET}  ${counts(tabs, p)}`, cols));
  lines.push(" ".repeat(cols));
  grouped(tabs).forEach((group) => {
    lines.push(pad(` ${fg(p.dim)}${group.title.toUpperCase()}${fg(p.faint)} ${group.tabs.length}${RESET}`, cols));
    group.tabs.forEach((tab, i) => {
      const chosen = tab.id === selected;
      if (chosen) cursorAt = lines.length;
      const fill = chosen ? bg(p.highlight) : "";
      const bar = `${fg(tab.color ?? p.faint)}${chosen ? "▌" : "▏"}${RESET}${fill}`;
      const nameColor = tab.id === view.here ? `${fg(p.bright)}${BOLD}` : fg(p.text);
      // The name wraps under itself, up to NAME_LINES lines.
      const indent = 6 + String(tab.index).length;
      const wrapped = wrap(tab.name, cols - indent);
      const name = wrapped.length > NAME_LINES ? [...wrapped.slice(0, NAME_LINES - 1), cut(wrapped.slice(NAME_LINES - 1).join(" "), cols - indent)] : wrapped;
      const first = `${bar}${badge(badgeState(tab), view.frame)}${fill} ${fg(p.faint)}${tab.index}${RESET}${fill} ${nameColor}${name[0]}${RESET}${fill}`;
      const rest = name.slice(1).map((line) => `${bar}${" ".repeat(indent - 1)}${nameColor}${line}${RESET}${fill}`);
      // What it is doing, packed onto as few lines as fit, breaking only
      // between its parts, so a PR number is never cut.
      const parts = [...stateWords(tab).split(" · "), tab.pr && `#${tab.pr}`].filter(Boolean);
      const details = parts.reduce((out, part) => {
        if (out.length && width(`${out.at(-1)} · ${part}`) <= cols - 6) out[out.length - 1] += ` · ${part}`;
        else out.push(part);
        return out;
      }, []);
      const stateColor = STATES[badgeState(tab)].color ?? p.dim;
      const below = details.map((detail) => `${bar}     ${fg(tab.state === "idle" ? p.dim : stateColor)}${detail}${RESET}${fill}`);
      [first, ...rest, ...below].forEach((line) => {
        owners[lines.length] = tab.id;
        lines.push(`${fill}${pad(line, cols)}${RESET}`);
      });
      if (chosen) cursorEnd = lines.length - 1;
      // A faint rule between tabs, which also spaces them apart.
      if (i < group.tabs.length - 1) lines.push(pad(` ${fg(p.highlight)}${"─".repeat(cols - 2)}${RESET}`, cols));
    });
    lines.push(" ".repeat(cols));
  });
  sections.filter((s) => s.sidebar).forEach((section) => {
    const attention = section.items.filter((i) => i.state === "attention").length;
    lines.push(pad(` ${fg(p.dim)}${section.title.toUpperCase()}${fg(p.faint)} ${section.items.length}${attention ? `${RESET} ${fg(220)}${BOLD}! ${attention}` : ""}${RESET}`, cols));
    if (section.error) lines.push(pad(`  ${fg(167)}${section.error}${RESET}`, cols));
    section.items.slice(0, section.sidebar).forEach((item) => {
      lines.push(pad(`  ${itemMark(item)} ${fg(p.text)}${item.title}${RESET}`, cols));
    });
    lines.push(" ".repeat(cols));
  });

  // Hints at the bottom while the sidebar has focus; the list scrolls to keep
  // the chosen tab in sight above them.
  const footer = view.focused ? [pad(` ${fg(p.dim)}↵ go  m mission  p actions  esc${RESET}`, cols)] : [];
  const room = rows - footer.length;
  const top = Math.max(0, Math.min(cursorAt, cursorEnd + 1 - room, lines.length - room));
  const shown = lines.slice(top, top + room);
  while (shown.length < room) shown.push(" ".repeat(cols));
  return { lines: [...shown, ...footer], owners: owners.slice(top, top + room) };
};

const ITEM_STATES = { attention: 220, active: 67, idle: undefined };
const itemMark = (item) => {
  const color = ITEM_STATES[item.state];
  return color ? `${fg(color)}${BOLD}●${RESET}` : `${fg(theme().faint)}○${RESET}`;
};

// Mission control lays tabs out in a grid of cards this size, as many across
// as fit.
const gridShape = (cols, rows, config) => {
  const across = Math.max(1, Math.floor(cols / config.cardWidth));
  const cardWidth = Math.floor(cols / across);
  const down = Math.max(1, Math.floor((rows - 2) / config.cardHeight));
  // Cards grow to fill the screen top to bottom.
  return { across, cardWidth, cardHeight: Math.max(6, Math.floor((rows - 2) / down)), down };
};

// Mission control's tabs laid out in stages (see model.js), packed: each row
// of the screen is a shelf of stage boxes side by side, one box per stage. A
// box takes its cards' width and two columns of border, and a shelf is
// `cols` wide. A stage that fits in the room left on the shelf goes there, in
// one row of cards; one that doesn't starts the next shelf, as wide as it
// needs up to the shelf, in as many rows of cards as it takes. A shelf is as
// tall as its tallest box, and the cards of a shorter box stretch to match.
//
// Returns the tabs in order; the shelves, each { rows, blocks: [{ stage,
// cards, across, rows }] } with cards as indices into that order; and the
// rows of cards the keys move through (j/k move a row, keeping the column),
// each { cards }: a shelf's rows, every box taking part in each, a shorter
// box's card spanning the rows its height covers.
const BORDER = 2;
// A card's width in mission control: a row of `across` cards fits even when
// every card is in a box, and border, of its own.
const missionCardWidth = (cols, config) => {
  const { across } = gridShape(cols, 0, config);
  return Math.max(20, Math.floor(cols / across) - BORDER);
};
const missionGrid = (tabs, cols = Infinity, cardWidth = 1) => {
  const order = [];
  const shelves = [];
  const fit = Math.max(1, Math.floor((cols - BORDER) / cardWidth));
  let shelf;
  let used = 0;
  staged(tabs).forEach((stage) => {
    const n = stage.tabs.length;
    const room = shelf ? Math.floor((cols - used - BORDER) / cardWidth) : 0;
    if (!shelf || room < n) {
      shelves.push((shelf = { rows: 0, blocks: [] }));
      used = 0;
    }
    const across = Math.min(n, fit);
    const rows = Math.ceil(n / across);
    const cards = stage.tabs.map((tab) => order.push(tab) - 1);
    shelf.blocks.push({ stage, cards, across, rows });
    shelf.rows = Math.max(shelf.rows, rows);
    used += BORDER + across * cardWidth;
  });
  const rows = shelves.flatMap((s) =>
    Array.from({ length: s.rows }, (_, i) => ({
      cards: s.blocks.flatMap((b) => {
        const row = Math.min(b.rows - 1, Math.floor((i * b.rows) / s.rows));
        return b.cards.slice(row * b.across, row * b.across + b.across);
      }),
    })),
  );
  return { order, shelves, rows };
};

// A tab's card: its mark and name in the border, what it is doing, and the
// latest turn: your prompt, then what Claude said last or the tool call it is
// stopped on.
const card = (tab, w, h, chosen, frame) => {
  const p = theme();
  const inner = w - 4;
  const border = chosen ? `${fg(tab.color ?? p.bright)}${BOLD}` : fg(p.faint);
  const title = ` ${badge(badgeState(tab), frame)} ${fg(p.dim)}${tab.index}${RESET} ${chosen ? `${fg(p.bright)}${BOLD}` : fg(p.text)}${cut(tab.name, inner - 9)}${RESET} `;
  const top = `${border}╭─${RESET}${title}${border}${"─".repeat(Math.max(0, w - 4 - width(title)))}─╮${RESET}`;
  const body = [];
  const stateColor = STATES[badgeState(tab)].color ?? p.dim;
  const facts = [stateWords(tab), tab.pr && `#${tab.pr}`, tab.claude?.name].filter(Boolean).join(" · ");
  body.push(`${fg(stateColor)}${facts}${RESET}`);
  const turn = tab.claude && transcriptFor(tab.claude) && lastTurn(transcriptFor(tab.claude));
  if (turn) {
    wrap(plain(turn.prompt), inner - 2).slice(0, 2).forEach((line, i) => body.push(`${fg(p.dim)}${i ? "  " : "› "}${line}${RESET}`));
    body.push("");
    // A turn stopped on a tool call is asking to run it, under the reply.
    const asking = turn.pending && tab.state === "waiting" ? wrap(`Asking: ${turn.pending}`, inner).slice(0, 2) : [];
    const reply = turn.reply ? plain(turn.reply) : tab.state === "working" ? `(working${turn.tools ? `, ${turn.tools} tool call${turn.tools === 1 ? "" : "s"} so far` : ""})` : "(no reply yet)";
    const room = h - 2 - body.length - (asking.length ? asking.length + 1 : 0);
    const lines = wrap(reply, inner);
    // The end of a long reply is where its question or conclusion is.
    const kept = lines.length > room ? ["…", ...lines.slice(lines.length - room + 1)] : lines;
    kept.forEach((line) => body.push(`${fg(p.text)}${line}${RESET}`));
    if (asking.length) body.push("", ...asking.map((line) => `${fg(220)}${BOLD}${line}${RESET}`));
  } else {
    body.push(`${fg(p.dim)}${tilde(tab.path)}${RESET}`);
  }
  const rowsOut = body.slice(0, h - 2).map((line) => `${border}│${RESET} ${pad(line, inner)} ${border}│${RESET}`);
  while (rowsOut.length < h - 2) rowsOut.push(`${border}│${RESET}${" ".repeat(w - 2)}${border}│${RESET}`);
  return [top, ...rowsOut, `${border}╰${"─".repeat(w - 2)}╯${RESET}`];
};

// Mission control: a bar naming the views (the tabs, then each plugin), the
// chosen view, and the keys. `view` is { view, cursor, frame }.
const missionLines = ({ tabs, sections, cols, rows, view, config }) => {
  const p = theme();
  const views = [{ title: "Tabs", count: tabs.length }, ...sections.map((s) => ({ title: s.title, count: s.items.length }))];
  const bar = views
    .map((v, i) => (i === view.view ? `${bg(p.highlight)}${fg(p.bright)}${BOLD} ${v.title} ${v.count} ${RESET}` : `${fg(p.dim)} ${v.title} ${v.count} ${RESET}`))
    .join(" ");
  const lines = [pad(` ${fg(81)}${BOLD}MISSION CONTROL${RESET}  ${bar}  ${counts(tabs, p)}`, cols)];
  const body = rows - 2;
  if (view.view === 0) {
    // Each shelf: every stage boxed in its color, titled on its top edge, its
    // cards in rows; a shelf as tall as its tallest box. Cards grow taller to
    // fill the screen when the shelves leave room, and the screen scrolls a
    // shelf at a time to keep the chosen card in view.
    const cardWidth = missionCardWidth(cols, config);
    const { order, shelves } = missionGrid(tabs, cols, cardWidth);
    const cardRows = shelves.reduce((sum, s) => sum + s.rows, 0);
    const cardHeight = Math.max(6, config.cardHeight, Math.min(30, Math.floor((body - BORDER * shelves.length) / Math.max(1, cardRows))));
    const drawn = [];
    let cursorTop = 0;
    let cursorBottom = 0;
    shelves.forEach((shelf) => {
      const top = drawn.length;
      const height = shelf.rows * cardHeight;
      const boxes = shelf.blocks.map((block) => {
        const color = fg(STATES[block.stage.color]?.color ?? p.dim);
        const inner = block.across * cardWidth;
        const title = ` ${block.stage.title.toUpperCase()} ${block.stage.tabs.length} `;
        const shownTitle = cut(title, Math.max(0, inner - 2));
        // Its rows of cards share the shelf's height, the last taking what is left.
        const body = Array.from({ length: block.rows }, (_, r) => {
          const h = r < block.rows - 1 ? Math.floor(height / block.rows) : height - Math.floor(height / block.rows) * (block.rows - 1);
          const cards = block.cards.slice(r * block.across, r * block.across + block.across).map((i) => card(order[i], cardWidth, h, i === view.cursor, view.frame));
          return Array.from({ length: h }, (_, line) => pad(cards.map((x) => x[line]).join(""), inner));
        }).flat();
        return [
          `${color}╭─${BOLD}${shownTitle}${RESET}${color}${"─".repeat(Math.max(0, inner - 1 - width(shownTitle)))}╮${RESET}`,
          ...body.map((line) => `${color}│${RESET}${line}${color}│${RESET}`),
          `${color}╰${"─".repeat(inner)}╯${RESET}`,
        ];
      });
      for (let line = 0; line < height + BORDER; line++) drawn.push(pad(boxes.map((box) => box[line]).join(""), cols));
      if (shelf.blocks.some((b) => b.cards.includes(view.cursor))) {
        cursorTop = top;
        cursorBottom = drawn.length;
      }
    });
    const start = Math.max(0, Math.min(cursorTop, cursorBottom - body));
    lines.push(...drawn.slice(start, start + body));
    if (!order.length) lines.push(pad(`  ${fg(p.dim)}No tabs.${RESET}`, cols));
  } else {
    const section = sections[view.view - 1];
    if (section.error) lines.push(pad(`  ${fg(167)}${section.error}${RESET}`, cols));
    if (!section.loaded) lines.push(pad(`  ${fg(p.dim)}Loading…${RESET}`, cols));
    else if (!section.items.length) lines.push(pad(`  ${fg(p.dim)}Nothing here.${RESET}`, cols));
    const first = Math.max(0, view.cursor - body + 2);
    section.items.slice(first, first + body - 1).forEach((item, i) => {
      const chosen = first + i === view.cursor;
      const fill = chosen ? bg(p.highlight) : "";
      const when = item.time ? ago(Math.floor(item.time / 1000)) : "";
      const left = `${fill} ${itemMark(item)}${fill} ${chosen ? `${fg(p.bright)}${BOLD}` : fg(p.text)}${item.title}${RESET}${fill}  ${fg(p.dim)}${item.detail ?? ""}`;
      lines.push(`${fill}${pad(left, cols - 6)}${fg(p.faint)}${when.padStart(5)} ${RESET}`);
    });
  }
  while (lines.length < rows - 1) lines.push(" ".repeat(cols));
  const hints = view.view === 0 ? "hjkl move  ↵ go to tab  p actions  M-key runs it in the tab  tab next view  esc close" : "jk move  ↵ open  r refresh  tab next view  esc close";
  return [...lines.slice(0, rows - 1), pad(` ${fg(p.dim)}${hints}${RESET}`, cols)];
};

// A frame as written to the terminal: cursor and wrapping off, each line put
// in place, so it can be written over the last one as it is.
const frame = (lines, title) =>
  `${title ? `\x1b]2;${title}\x07` : ""}\x1b[?25l\x1b[?7l${lines.map((line, i) => `\x1b[${i + 1};1H${line}${RESET}`).join("")}`;

module.exports = { missionGrid, missionCardWidth, sidebarLines, missionLines, gridShape, frame, stateWords, tilde };
