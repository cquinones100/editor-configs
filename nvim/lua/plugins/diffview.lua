-- diffview.nvim: a branch's changes as GitHub's "Files changed" shows them, a
-- file tree beside a side-by-side diff of the chosen file. q closes it.
--
-- tmux's M-d opens it in a pane's place (tmux/pane-in-place.sh) as
-- `:DiffviewOpen <origin's default branch> --merge-base`: everything since the
-- branch left it, uncommitted changes included. That Neovim is started with
-- g:diff_pane set, and closing the last view quits it, which puts the pane
-- back; so does C-c, as in lazygit.
--
-- Moving the cursor in the file tree shows that file's diff, as the tmux
-- sidebar shows a tab, with the cursor left in the tree. c lists the branch's
-- commits (`:DiffviewFileHistory` over them), each showing its changes the
-- same way, and c or q there goes back to the whole branch.
local close = { "n", "q", "<cmd>DiffviewClose<cr>", { desc = "Close the diff" } }

local quit = {
  "n",
  "<C-c>",
  function()
    vim.cmd(vim.g.diff_pane and "qa" or "DiffviewClose")
  end,
  { desc = "Close the diff and go back" },
}

-- origin's default branch, as pane-in-place.sh finds it, else main.
local function base()
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
      if item.files then
        if item.files[1] then view:set_file(item.files[1], false) end
      elseif type(item.collapsed) ~= "boolean" then
        view:set_file(item, false)
      end
    end)
  )
end

return {
  "sindrets/diffview.nvim",
  cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewFileHistory" },
  opts = {
    keymaps = {
      view = { close, quit },
      file_panel = { close, quit, commits },
      file_history_panel = { close, quit, back },
    },
  },
  config = function(_, opts)
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
