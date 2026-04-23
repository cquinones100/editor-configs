return {
  { "windwp/nvim-autopairs", event = "InsertEnter", opts = {} },
  {
    "numToStr/Comment.nvim",
    event = { "BufReadPost", "BufNewFile" },
    config = function()
      require("Comment").setup({ mappings = false })
      vim.keymap.set("n", "gc", function()
        require("Comment.api").toggle.linewise.current()
      end, { desc = "Toggle comment on current line" })
      vim.keymap.set("x", "gc", function()
        local esc = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
        vim.api.nvim_feedkeys(esc, "nx", false)
        require("Comment.api").locked("toggle.linewise")(vim.fn.visualmode())
      end, { desc = "Toggle comment on selection" })
    end,
  },
}
