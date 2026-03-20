return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdate",
  opts = {
    ensure_installed = {
      "typescript", "tsx", "javascript",
      "python", "ruby",
      "html", "css",
      "json", "yaml", "toml",
      "lua", "vim", "vimdoc",
      "markdown", "markdown_inline",
    },
    highlight = { enable = true },
    indent = { enable = true },
  },
  config = function(_, opts)
    require("nvim-treesitter.configs").setup(opts)
  end,
}
