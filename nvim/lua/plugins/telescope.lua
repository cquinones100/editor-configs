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

    local actions = require("telescope.actions")
    local action_state = require("telescope.actions.state")

    local builtin = require("telescope.builtin")
    vim.keymap.set("n", "<C-p>", function()
      builtin.find_files({
        hidden = true,
        attach_mappings = function(_, map)
          map("i", "<C-y>", function(prompt_bufnr)
            local entry = action_state.get_selected_entry()
            actions.close(prompt_bufnr)
            vim.fn.setreg("+", entry[1])
            vim.notify("Copied: " .. entry[1])
          end)
          return true
        end,
      })
    end)
    vim.keymap.set("n", "<C-S-f>", builtin.live_grep)
    vim.keymap.set("n", "<C-S-p>", builtin.keymaps)
    vim.keymap.set("n", "<leader>fb", builtin.buffers)
    vim.keymap.set("n", "<leader>fh", builtin.help_tags)
    vim.keymap.set("n", "<leader>fr", builtin.oldfiles)
    vim.keymap.set("n", "<leader>fd", builtin.diagnostics)
  end,
}
