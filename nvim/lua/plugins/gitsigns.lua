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
        local pr = vim.fn.system({ "gh", "pr", "list", "--search", sha, "--state", "merged", "--json", "number", "--jq", ".[0].number" })
        pr = vim.trim(pr)
        if pr == "" then
          vim.notify("No PR found for this commit, opening commit instead", vim.log.levels.INFO)
          vim.fn.jobstart({ "gh", "browse", sha }, { detach = true })
        else
          vim.fn.jobstart({ "gh", "pr", "view", pr, "--web" }, { detach = true })
        end
      end,
      desc = "Open blame PR on GitHub",
    },
    {
      "<leader>go",
      function()
        local file = vim.fn.expand("%:.")
        local line = vim.api.nvim_win_get_cursor(0)[1]
        local main = vim.trim(vim.fn.system({ "gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name" }))
        vim.fn.jobstart({ "gh", "browse", file .. ":" .. line, "--branch", main }, { detach = true })
      end,
      desc = "Open file on GitHub",
    },
  },
}
