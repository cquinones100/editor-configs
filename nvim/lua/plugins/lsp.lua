-- ruby-lsp needs Ruby 2.7 or newer to install. macOS ships 2.6, so on a Mac
-- with only that, asking for it failed again, with an error, every time
-- Neovim started.
local function modern_ruby()
  if vim.fn.executable("ruby") == 0 then return false end
  local ok, result = pcall(function() return vim.system({ "ruby", "-e", "print RUBY_VERSION" }, { text = true }):wait(2000) end)
  if not ok or result.code ~= 0 then return false end
  local major, minor = (result.stdout or ""):match("^(%d+)%.(%d+)")
  return major and (tonumber(major) > 2 or (tonumber(major) == 2 and tonumber(minor) >= 7)) or false
end

-- None of this in the notes app (bin/notes sets g:notes_app): a note needs no
-- language server, and the installs only slowed its start and showed errors.
return {
  {
    "williamboman/mason.nvim",
    cond = not vim.g.notes_app,
    opts = {},
  },
  {
    "williamboman/mason-lspconfig.nvim",
    cond = not vim.g.notes_app,
    dependencies = {
      "williamboman/mason.nvim",
      "neovim/nvim-lspconfig",
    },
    opts = {
      ensure_installed = {
        "ts_ls",
        "pyright",
        "html",
        "cssls",
        "tailwindcss",
        "emmet_ls",
      },
    },
    config = function(_, opts)
      if modern_ruby() then table.insert(opts.ensure_installed, "ruby_lsp") end
      require("mason-lspconfig").setup(opts)

      local capabilities = require("cmp_nvim_lsp").default_capabilities()
      vim.lsp.config("*", { capabilities = capabilities })
    end,
  },
  {
    "hrsh7th/nvim-cmp",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-path",
      "L3MON4D3/LuaSnip",
      "saadparwaiz1/cmp_luasnip",
    },
    config = function()
      local cmp = require("cmp")
      local luasnip = require("luasnip")

      cmp.setup({
        snippet = {
          expand = function(args)
            luasnip.lsp_expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["<C-b>"] = cmp.mapping.scroll_docs(-4),
          ["<C-f>"] = cmp.mapping.scroll_docs(4),
          ["<C-Space>"] = cmp.mapping.complete(),
          ["<C-e>"] = cmp.mapping.abort(),
          ["<CR>"] = cmp.mapping.confirm({ select = false }),
        }),
        sources = cmp.config.sources({
          { name = "nvim_lsp" },
          { name = "luasnip" },
        }, {
          { name = "buffer" },
          { name = "path" },
        }),
      })
    end,
  },
}
