// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Keys from a client's terminal, which is in raw mode, named the way tmux
// names them (Up, Enter, M-p, C-l), so a key the sidebar doesn't use itself
// can be handed to tmux with send-keys -K and run whatever it is bound to.
// tmux has escape-time 0, so a lone Escape arrives alone and Alt+x arrives as
// Escape and x together.

const CSI = { A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End", Z: "BTab" };
const CONTROL = { "\r": "Enter", "\t": "Tab", "\x7f": "BSpace", "\x1b": "Escape", " ": "Space" };

// [{ key }] or [{ mouse: { button, x, y, press } }], in order.
const parseKeys = (chunk) => {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    const csi = /^\x1b\[(?:[\d;]*)([A-Z~])/.exec(rest);
    if (mouse) {
      keys.push({ mouse: { button: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), press: mouse[4] === "M" } });
      i += mouse[0].length;
    } else if (csi) {
      keys.push({ key: CSI[csi[1]] ?? "Unknown" });
      i += csi[0].length;
    } else if (rest[0] === "\x1b" && rest.length > 1) {
      const [char] = [...rest.slice(1)];
      keys.push({ key: `M-${CONTROL[char] ?? char}` });
      i += 1 + char.length;
    } else {
      const [char] = [...rest];
      const code = char.codePointAt(0);
      if (CONTROL[char]) keys.push({ key: CONTROL[char] });
      else if (code < 32) keys.push({ key: `C-${String.fromCharCode(code + 96)}` });
      else keys.push({ key: char });
      i += char.length;
    }
  }
  return keys;
};

module.exports = { parseKeys };
