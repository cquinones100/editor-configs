-- ── Shared Settings ──────────────────────────────────
vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.scrolloff = 8
vim.opt.tabstop = 2
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.clipboard = "unnamed"
vim.opt.hlsearch = false
vim.opt.incsearch = true
vim.opt.splitright = true
vim.opt.splitbelow = true
vim.opt.updatetime = 50

-- Move highlighted text up or down
vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

-- Keep cursor in the middle when jumping
vim.keymap.set("n", "<C-d>", "<C-d>M")
vim.keymap.set("n", "<C-u>", "<C-u>M")

-- Replace currently hovered word
vim.keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])

-- Escape with Ctrl+C in insert mode
vim.keymap.set("i", "<C-c>", "<Esc>")

-- ── VSCode-specific ──────────────────────────────────
if vim.g.vscode then
  vim.keymap.set("n", "<S-y>", "yy")
  vim.keymap.set("n", "<S-c-c>", function() vim.fn.setreg("+", vim.fn.expand("%:p")) end)
  vim.keymap.set("n", "<C-s>", vim.cmd.w)
  vim.keymap.set("n", "<C-a>", "ggVG")
  return
end

-- ── Standalone Settings ──────────────────────────────
vim.opt.termguicolors = true
vim.opt.signcolumn = "yes"
vim.opt.cursorline = true
vim.opt.wrap = false
vim.opt.undofile = true
vim.opt.ignorecase = true
vim.opt.smartcase = true

vim.filetype.add({
  extension = {
    tfvars = "terraform-vars",
  },
})

-- ── Bootstrap lazy.nvim ──────────────────────────────
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup("plugins")

-- ── LSP Keymaps ──────────────────────────────────────
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(event)
    local map = function(keys, func)
      vim.keymap.set("n", keys, func, { buffer = event.buf })
    end
    map("gd", vim.lsp.buf.definition)
    map("gr", vim.lsp.buf.references)
    map("gi", vim.lsp.buf.implementation)
    map("K", vim.lsp.buf.hover)
    map("<leader>rn", vim.lsp.buf.rename)
    map("<leader>ca", vim.lsp.buf.code_action)
    map("[d", vim.diagnostic.goto_prev)
    map("]d", vim.diagnostic.goto_next)
  end,
})
