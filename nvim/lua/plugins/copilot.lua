return {
  "github/copilot.vim",
  event = "InsertEnter",
  -- Never in the notes app (bin/notes sets g:notes_app), so notes aren't
  -- sent to Copilot's server.
  cond = not vim.g.notes_app,
}
