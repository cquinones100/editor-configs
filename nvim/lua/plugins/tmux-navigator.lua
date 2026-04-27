return {
  "christoomey/vim-tmux-navigator",
  cmd = {
    "TmuxNavigateLeft",
    "TmuxNavigateDown",
    "TmuxNavigateUp",
    "TmuxNavigateRight",
  },
  init = function()
    vim.g.tmux_navigator_no_mappings = 1
  end,
  keys = {
    { "<C-w>h", "<cmd>TmuxNavigateLeft<cr>",  mode = "n" },
    { "<C-w>j", "<cmd>TmuxNavigateDown<cr>",  mode = "n" },
    { "<C-w>k", "<cmd>TmuxNavigateUp<cr>",    mode = "n" },
    { "<C-w>l", "<cmd>TmuxNavigateRight<cr>", mode = "n" },
  },
}
