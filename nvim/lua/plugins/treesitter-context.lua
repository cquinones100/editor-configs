return {
  "nvim-treesitter/nvim-treesitter-context",
  dependencies = { "nvim-treesitter/nvim-treesitter" },
  event = { "BufReadPost", "BufNewFile" },
  opts = {
    max_lines = 3,
    trim_scope = "outer",
    mode = "cursor",
  },
  keys = {
    {
      "<leader>uc",
      "<cmd>TSContextToggle<CR>",
      desc = "Toggle sticky context",
    },
  },
}
