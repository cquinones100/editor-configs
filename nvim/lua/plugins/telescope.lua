return {
  "nvim-telescope/telescope.nvim",
  branch = "master",
  dependencies = {
    "nvim-lua/plenary.nvim",
    { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
  },
  config = function()
    local telescope = require("telescope")
    telescope.setup({
      defaults = {
        file_ignore_patterns = { "node_modules", ".git/" },
      },
    })
    telescope.load_extension("fzf")

    local builtin = require("telescope.builtin")
    vim.keymap.set("n", "<C-p>", builtin.find_files)
    vim.keymap.set("n", "<C-S-f>", builtin.live_grep)
    vim.keymap.set("n", "<C-S-p>", builtin.keymaps)
    vim.keymap.set("n", "<leader>fb", builtin.buffers)
    vim.keymap.set("n", "<leader>fh", builtin.help_tags)
    vim.keymap.set("n", "<leader>fr", builtin.oldfiles)
    vim.keymap.set("n", "<leader>fd", builtin.diagnostics)
  end,
}
