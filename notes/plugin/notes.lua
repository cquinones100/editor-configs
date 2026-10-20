-- :Notes opens the notes app in the current tab (see lua/notes/init.lua).
vim.api.nvim_create_user_command("Notes", function() require("notes").start() end, { desc = "Open Notes" })
