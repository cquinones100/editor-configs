-- Collapsible sections, as Notes has them: a title, heading or subheading
-- folds everything under it up to the next one of the same or a higher
-- level. Enter or a click on a heading's ▾ folds or unfolds it (see init.lua),
-- and vim's own z commands work too. A folded heading shows as ▸ and its
-- text, with how many lines are hidden.

local M = {}

local render = require("notes.render")

-- The kinds of a buffer's lines, worked out once per change.
local cache = {}
local function kinds(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local cached = cache[buf]
  if cached and cached.tick == tick then return cached.kinds end
  local k = render.kinds(vim.api.nvim_buf_get_lines(buf, 0, -1, false))
  cache[buf] = { tick = tick, kinds = k }
  return k
end

local LEVEL = { title = 1, heading = 2, subheading = 3 }

-- For 'foldexpr'.
function M.expr()
  local k = kinds(vim.api.nvim_get_current_buf())[vim.v.lnum]
  local level = k and LEVEL[k.kind]
  return level and (">" .. level) or "="
end

-- For 'foldtext'.
function M.text()
  local line = vim.fn.getline(vim.v.foldstart):gsub("^#+%s*", "")
  local hidden = vim.v.foldend - vim.v.foldstart
  return string.format("▸ %s  (%d line%s)", line, hidden, hidden == 1 and "" or "s")
end

-- Folds or unfolds the section a heading on `row` starts. Returns whether
-- the row is a heading.
function M.toggle(buf, row)
  local k = kinds(buf)[row]
  if not (k and LEVEL[k.kind]) then return false end
  if vim.fn.foldclosed(row) ~= -1 then
    vim.cmd(row .. "foldopen")
  elseif vim.fn.foldlevel(row) > 0 then
    vim.cmd(row .. "foldclose")
  end
  return true
end

function M.attach(win)
  local wo = vim.wo[win]
  wo.foldmethod = "expr"
  wo.foldexpr = "v:lua.require'notes.fold'.expr()"
  wo.foldtext = "v:lua.require'notes.fold'.text()"
  wo.foldlevel = 99
  wo.foldenable = true
  wo.fillchars = "fold: ,eob: "
end

return M
