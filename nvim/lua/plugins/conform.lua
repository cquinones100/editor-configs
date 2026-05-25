return {
  "stevearc/conform.nvim",
  event = { "BufWritePre" },
  cmd = { "ConformInfo" },
  opts = {
    formatters_by_ft = {
      javascript = { "prettierd", "prettier", "eslint_d", stop_after_first = true },
      javascriptreact = { "prettierd", "prettier", "eslint_d", stop_after_first = true },
      typescript = { "prettierd", "prettier", "eslint_d", stop_after_first = true },
      typescriptreact = { "prettierd", "prettier", "eslint_d", stop_after_first = true },
      json = { "prettierd", "prettier", stop_after_first = true },
      jsonc = { "prettierd", "prettier", stop_after_first = true },
      css = { "prettierd", "prettier", stop_after_first = true },
      html = { "prettierd", "prettier", stop_after_first = true },
      markdown = { "prettierd", "prettier", stop_after_first = true },
      yaml = { "prettierd", "prettier", stop_after_first = true },
      lua = { "stylua" },
      ruby = { "rubocop" },
      python = { "ruff_format" },
    },
    format_on_save = {
      timeout_ms = 2000,
      lsp_format = "fallback",
    },
  },
  init = function()
    vim.keymap.set({ "n", "v" }, "<leader>f", function()
      require("conform").format({ async = true, lsp_format = "fallback" })
    end, { desc = "Format buffer/selection" })
  end,
}
