if vim.g.vscode then
  vim.opt.number = true
  vim.opt.relativenumber = true
  vim.opt.scrolloff = 16
  vim.opt.incsearch = true
  vim.opt.scrolloff = 8
  vim.opt.nu = true
  vim.opt.updatetime = 50

  vim.opt.tabstop = 2
  vim.opt.softtabstop = 2
  vim.opt.shiftwidth = 2
  vim.opt.expandtab = true

  vim.opt.clipboard = "unnamed"

  vim.opt.hlsearch = false
  vim.opt.incsearch = true

  vim.opt.splitright = true
  vim.opt.splitbelow = true

  vim.g.mapleader = " "

  -- move highlighted text up or down
  vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
  vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

  -- keep cursor in the middle when jumping up or down
  vim.keymap.set("n", "<c-d>", "<C-d>M")
  vim.keymap.set("n", "<c-u>", "<C-u>M")

  -- yank whole line shift+y
  vim.keymap.set("n", "<S-y>", "yy")

  vim.keymap.set("i", "<C-c>", "<Esc>")

  -- replace currently hovered word
  vim.keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])

  -- copy file path to clipboard
  vim.keymap.set("n", "<S-c-c>", function() vim.fn.setreg("+", vim.fn.expand("%:p")) end)

  vim.keymap.set("n", "<C-s>", vim.cmd.w)

  -- select all
  vim.keymap.set("n", "<C-a>", "ggVG")
end
