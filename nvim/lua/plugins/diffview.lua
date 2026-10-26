-- diffview.nvim: a branch's changes as GitHub's "Files changed" shows them, a
-- file tree beside a side-by-side diff of the chosen file. q closes it, and
-- Esc in the file tree or history.
--
-- tmux's M-d opens it in a pane's place (tmux/pane-in-place.sh) as
-- `:DiffviewOpen origin/<base>...HEAD`, the PR's base branch freshly fetched:
-- the branch's committed changes as GitHub's "Files changed" shows them, and
-- the base in g:diff_base. That Neovim is started with
-- g:diff_pane set, and closing the last view quits it, which puts the pane
-- back; so does C-c, as in lazygit.
--
-- The highlighting is quieter than Vim's (see minimal_highlights): only
-- changed words, and faint added and removed lines.
--
-- It opens on the first file someone wrote, not one a tool made (a lockfile,
-- a migration snapshot, a minified or built file; see generated()), and shows
-- an added file alone, on one side, and a deleted one as it was, rather than
-- beside an empty half.
--
-- Moving the cursor in the file tree shows that file's diff, as the tmux
-- sidebar shows a tab, with the cursor left in the tree. c lists the branch's
-- commits (`:DiffviewFileHistory` over them), each showing its changes the
-- same way, and c or q there goes back to the whole branch.
local close = { "n", "q", "<cmd>DiffviewClose<cr>", { desc = "Close the diff" } }
-- Esc too, in the file tree and the history, where it has nothing else to do,
-- so diffview closes as lazygit and every popup do. Not in the diff itself,
-- where Esc leaves insert mode.
local escape = { "n", "<esc>", "<cmd>DiffviewClose<cr>", { desc = "Close the diff" } }

local quit = {
  "n",
  "<C-c>",
  function()
    vim.cmd(vim.g.diff_pane and "qa" or "DiffviewClose")
  end,
  { desc = "Close the diff and go back" },
}

-- The base pane-in-place.sh compared with, else origin's default branch, else
-- main.
local function base()
  if vim.g.diff_base then return vim.g.diff_base end
  local out = vim.fn.systemlist({ "git", "rev-parse", "--abbrev-ref", "origin/HEAD" })
  return vim.v.shell_error == 0 and out[1] or "main"
end

local commits = {
  "n",
  "c",
  function()
    vim.cmd("DiffviewFileHistory --range=" .. base() .. "..HEAD")
  end,
  { desc = "The branch's commits" },
}

local back = { "n", "c", "<cmd>DiffviewClose<cr>", { desc = "Back to the whole branch" } }

-- Shows the file under the cursor in the tree, or a commit's first file in
-- the history, without moving the cursor. A folder or commit is never folded
-- by moving over it. Waits for the cursor to settle, so holding j doesn't load
-- every diff on the way.
local timer = vim.uv.new_timer()
local function follow()
  timer:stop()
  timer:start(
    60,
    0,
    vim.schedule_wrap(function()
      local view = require("diffview.lib").get_current_view()
      if not view or not view.panel:is_focused() then return end
      local item = view.panel:get_item_at_cursor()
      if not item or item == view.followed then return end
      view.followed = item
      -- Going from a file on one side to one on two, or back, makes new
      -- windows, which takes the cursor; file_open_post gives it back.
      view.keep_panel = true
      if item.files then
        if item.files[1] then view:set_file(item.files[1], false) end
      elseif type(item.collapsed) ~= "boolean" then
        view:set_file(item, false)
      end
    end)
  )
end

-- Files a tool writes, which a reader skips: lockfiles, ORM migration
-- snapshots (Drizzle's meta/*.json), test snapshots, minified, source-mapped
-- and built or generated output.
local lockfiles = {
  ["pnpm-lock.yaml"] = true, ["package-lock.json"] = true, ["yarn.lock"] = true, ["bun.lockb"] = true,
  ["Cargo.lock"] = true, ["Gemfile.lock"] = true, ["poetry.lock"] = true, ["uv.lock"] = true,
  ["Pipfile.lock"] = true, ["composer.lock"] = true, ["go.sum"] = true, ["flake.lock"] = true, ["mix.lock"] = true,
}
local generated_patterns = {
  "/meta/[^/]+%.json$", "_snapshot%.json$", "%.snap$", "%.min%.[jc]ss?$", "%.map$",
  "^dist/", "/dist/", "^build/", "/build/", "/generated/", "/__generated__/", "%.generated%.", "%.pb%.go$",
}
local function generated(path)
  if lockfiles[vim.fs.basename(path)] then return true end
  for _, pattern in ipairs(generated_patterns) do
    if ("/" .. path):match(pattern) then return true end
  end
  return false
end

-- An added or deleted file on one side only: diffview's single-window layout
-- (Diff1) showing the new file, or for a deleted one the old file in its
-- place. Returns whether the entry changed.
local function one_sided(entry)
  local Diff1 = require("diffview.scene.layouts.diff_1").Diff1
  if not entry.layout or entry.layout:instanceof(Diff1) then return false end
  if entry.status == "A" or entry.status == "?" then
    entry:convert_layout(Diff1)
    return true
  elseif entry.status == "D" and entry.layout.a then
    entry.layout = Diff1({ b = entry.layout.a.file })
    return true
  end
  return false
end

-- Before diffview opens a file after listing them: added and deleted ones put
-- on one side, and, the first time, the first file that isn't generated
-- chosen in place of the first in the list. It has to be before: diffview
-- opens the file without waiting, so changing layouts or the file once it
-- reports the list (files_updated) pulled the layout out from under the open
-- still under way, and every startup ended in errors. The entry already shown
-- is left as it is, for the same reason; a new or changed one is a new entry.
local function wrap_set_file(view)
  local set_file = view.set_file
  view.set_file = function(self, file, focus, highlight)
    local files = self.panel:ordered_file_list()
    for _, entry in ipairs(files) do
      if entry ~= self.cur_entry then one_sided(entry) end
    end
    if not self.picked_first and #files > 0 then
      self.picked_first = true
      for _, entry in ipairs(files) do
        if not generated(entry.path) then
          file, highlight = entry, true
          break
        end
      end
    end
    return set_file(self, file, focus, highlight)
  end
end

-- Quieter highlighting, in diffview's windows only, so what changed stands
-- out: a changed line gets no tint, only its changed words do (the
-- colourscheme's DiffText); added and removed lines a faint one, a quarter of
-- the colourscheme's own, over the background; and the gap where the other
-- side has no lines is left blank rather than hatched. Worked out again when
-- the colourscheme changes.
local function blend(fg, bg, amount)
  local function channel(c, shift) return math.floor(c / 2 ^ shift) % 256 end
  local mix = 0
  for _, shift in ipairs({ 16, 8, 0 }) do
    mix = mix + math.floor(channel(fg, shift) * amount + channel(bg, shift) * (1 - amount) + 0.5) * 2 ^ shift
  end
  return mix
end

-- Syntax groups that paint a background of their own, as tokyonight does for
-- a Markdown heading or inline code: in a diff those read as more
-- highlighting, so there each is drawn by a copy without its background,
-- keeping its colour. Found again with every colourscheme.
local unpainted = {}

local function minimal_highlights()
  -- tokyonight is transparent, with no Normal background, so its storm one.
  local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false }).bg or 0x24283b
  unpainted = {}
  for name in pairs(vim.api.nvim_get_hl(0, {})) do
    local hl = vim.api.nvim_get_hl(0, { name = name, link = false })
    if hl.bg and name:match("^@") and not name:match("^@diff") then
      local copy = "DiffviewMinimalNoBg" .. name:gsub("[^%w]", "_")
      hl.bg = nil
      vim.api.nvim_set_hl(0, copy, hl)
      table.insert(unpainted, name .. ":" .. copy)
    end
  end
  local function faint(name)
    local bg = vim.api.nvim_get_hl(0, { name = name, link = false }).bg
    return bg and { bg = blend(bg, normal, 0.25) } or {}
  end
  vim.api.nvim_set_hl(0, "DiffviewMinimalAdd", faint("DiffAdd"))
  vim.api.nvim_set_hl(0, "DiffviewMinimalDelete", faint("DiffDelete"))
  vim.api.nvim_set_hl(0, "DiffviewMinimalChange", {})
  vim.api.nvim_set_hl(0, "DiffviewMinimalText", { link = "DiffText" })
  vim.api.nvim_set_hl(0, "DiffviewMinimalFiller", { fg = normal, bg = normal })
end

-- Per side: Vim calls a line only one side has an addition on that side, so
-- on the left (the old side, diffview's "a") it is a removed line, and on the
-- right an added one. The gap facing it (DiffDelete) is blank on both.
local function minimal_for(side)
  return table.concat({
    side == "a" and "DiffAdd:DiffviewMinimalDelete" or "DiffAdd:DiffviewMinimalAdd",
    "DiffDelete:DiffviewMinimalFiller",
    "DiffChange:DiffviewMinimalChange",
    "DiffText:DiffviewMinimalText",
    unpack(unpainted),
  }, ",")
end

return {
  "sindrets/diffview.nvim",
  cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewFileHistory" },
  opts = {
    file_panel = { win_config = { width = 40 } },
    hooks = {
      view_opened = function(view)
        if view.panel and view.panel.ordered_file_list then wrap_set_file(view) end
        if view.emitter then
          view.emitter:on("file_open_post", function()
            if view.keep_panel and view.panel:is_open() then view.panel:focus() end
            view.keep_panel = false
          end)
        end
      end,
      diff_buf_win_enter = function(_, winid, ctx)
        vim.wo[winid].winhighlight = minimal_for(ctx and ctx.symbol)
        vim.wo[winid].fillchars = "diff: "
        vim.wo[winid].cursorline = false
      end,
    },
    keymaps = {
      view = { close, quit },
      file_panel = { close, escape, quit, commits },
      file_history_panel = { close, escape, quit, back },
    },
  },
  config = function(_, opts)
    -- Lines matched as people read them: histogram rather than Myers, the
    -- indent heuristic, and linematch pairing the lines of a changed block,
    -- so fewer lines look changed than were.
    vim.opt.diffopt:append({ "algorithm:histogram", "indent-heuristic", "linematch:60" })
    minimal_highlights()
    vim.api.nvim_create_autocmd("ColorScheme", { callback = minimal_highlights })
    require("diffview").setup(opts)
    vim.api.nvim_create_autocmd("FileType", {
      pattern = { "DiffviewFiles", "DiffviewFileHistory" },
      callback = function(args)
        vim.api.nvim_create_autocmd("CursorMoved", { buffer = args.buf, callback = follow })
      end,
    })
    vim.api.nvim_create_autocmd("User", {
      pattern = "DiffviewViewClosed",
      callback = function()
        -- The view leaves the list after this event, so look once it has.
        vim.schedule(function()
          if vim.g.diff_pane and #require("diffview.lib").views == 0 then vim.cmd("qa") end
        end)
      end,
    })
  end,
}
