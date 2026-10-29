-- Squashing notes: two or more marked in the sidebar (s marks, S squashes)
-- become one, merged by a headless Claude, after you say yes, since it sends
-- their text to Claude. Sonnet merges: careful enough not to drop an item,
-- which Haiku would risk, at a fraction of Opus's cost (the squash_model
-- option). The new note goes in the first one's folder, the originals go to
-- Recently Deleted, so nothing is lost, and every tmux tab linked to one of
-- them (tmux/notes-open.sh's @tab_note and @tab_note_last) links to the new
-- one.

local M = {}

local store = require("notes.store")

M.options = { model = "sonnet" }

local PROMPT = table.concat({
  "Merge the notes below into one Markdown note.",
  "Its first line is '# ' and a title that covers them all.",
  "Keep every item, every checklist box as it is ([ ] or [x]), every link and every detail, and group what belongs together under headings;",
  "drop only what is said twice, keeping the fuller one. Leave the ticked items of a checklist under its unticked ones, a blank line between.",
  "Write nothing but the note: no preamble, no code fence around it.",
}, " ")

-- The tabs linked to one of `from` (paths in the notes directory) link to `to`.
local function relink(from, to)
  if (vim.env.TMUX or "") == "" then return end
  local listed = vim.system({ "tmux", "list-windows", "-a", "-F", "#{window_id}\t#{@tab_note}\t#{@tab_note_last}" }, { text = true }):wait()
  if listed.code ~= 0 then return end
  local old = {}
  for _, rel in ipairs(from) do old[rel] = true end
  for line in (listed.stdout or ""):gmatch("[^\n]+") do
    local window, note, last = line:match("^([^\t]*)\t([^\t]*)\t(.*)$")
    if window and old[note] then vim.system({ "tmux", "set-option", "-w", "-t", window, "@tab_note", to }):wait() end
    if window and old[last] then vim.system({ "tmux", "set-option", "-w", "-t", window, "@tab_note_last", to }):wait() end
  end
end

-- Squashes `paths` (absolute, two or more), calling done(new path) or
-- done(nil, why) when it is over. The merge runs in the background.
function M.run(paths, done)
  local parts = {}
  for i, path in ipairs(paths) do
    local f = io.open(path, "r")
    if not f then return done(nil, "couldn't read " .. store.relative(path)) end
    table.insert(parts, ("<note %d>\n%s\n</note %d>"):format(i, f:read("*a"), i))
    f:close()
  end
  local ok, job = pcall(vim.system, { "claude", "-p", "--model", M.options.model, "--tools", "", "--no-session-persistence", PROMPT }, { text = true, stdin = table.concat(parts, "\n\n") }, function(out)
    vim.schedule(function()
      local text = vim.trim(out.stdout or ""):gsub("^```%w*\n", ""):gsub("\n```$", "")
      if out.code ~= 0 or not text:match("^# %S") then
        return done(nil, "Claude didn't merge them" .. (out.stderr ~= "" and (": " .. vim.trim(out.stderr):match("[^\n]*")) or ""))
      end
      local folder = vim.fs.dirname(store.relative(paths[1]))
      local path = store.create(folder == "." and "" or folder, store.title_of(text))
      local f = io.open(path, "w")
      if not f then return done(nil, "couldn't write the new note") end
      f:write(text .. "\n")
      f:close()
      local rels = {}
      for _, old in ipairs(paths) do
        table.insert(rels, store.relative(old))
        require("notes").forget(old)
        store.delete(old)
      end
      relink(rels, store.relative(path))
      done(path)
    end)
  end)
  if not ok then done(nil, "Claude Code isn't installed") end
  return job
end

return M
