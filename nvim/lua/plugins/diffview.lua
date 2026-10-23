-- diffview.nvim: a branch's changes as GitHub's "Files changed" shows them, a
-- file tree beside a side-by-side diff of the chosen file. q closes it.
--
-- tmux's M-d opens it in a pane's place (tmux/pane-in-place.sh) as
-- `:DiffviewOpen <origin's default branch> --merge-base`: everything since the
-- branch left it, uncommitted changes included. That Neovim is started with
-- g:diff_pane set, and closing the view quits it, which puts the pane back.
local close = { "n", "q", "<cmd>DiffviewClose<cr>", { desc = "Close the diff" } }

return {
  "sindrets/diffview.nvim",
  cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewFileHistory" },
  opts = {
    keymaps = {
      view = { close },
      file_panel = { close },
      file_history_panel = { close },
    },
  },
  config = function(_, opts)
    require("diffview").setup(opts)
    vim.api.nvim_create_autocmd("User", {
      pattern = "DiffviewViewClosed",
      callback = function()
        if vim.g.diff_pane then vim.cmd("qa") end
      end,
    })
  end,
}
