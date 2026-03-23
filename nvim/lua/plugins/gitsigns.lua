return {
  "lewis6991/gitsigns.nvim",
  opts = {
    current_line_blame = true,
    current_line_blame_opts = {
      delay = 300,
    },
  },
  keys = {
    {
      "<leader>gp",
      function()
        local file = vim.fn.expand("%")
        local line = vim.api.nvim_win_get_cursor(0)[1]
        local result = vim.fn.system({ "git", "blame", "-L", line .. "," .. line, "--porcelain", file })
        local sha = result:match("^(%x+)")
        if not sha or sha:match("^0+$") then
          vim.notify("No commit for this line (uncommitted change)", vim.log.levels.WARN)
          return
        end
        vim.fn.jobstart({ "gh", "browse", sha }, { detach = true })
      end,
      desc = "Open blame commit on GitHub",
    },
  },
}
