-- Ghostty's own colors (colors/ghostty.lua), through mini.base16, applied
-- again whenever tmux/theme.sh switches Ghostty's theme, which it does by
-- writing ~/.config/ghostty/theme-mode.conf, so every Neovim open follows the
-- terminal between dark and light.
return {
  "echasnovski/mini.base16",
  lazy = false,
  priority = 1000,
  config = function()
    vim.cmd.colorscheme("ghostty")
    local dir = vim.fn.expand("~/.config/ghostty")
    local watch = vim.uv.new_fs_event()
    if not (watch and vim.uv.fs_stat(dir)) then return end
    watch:start(dir, {}, function(_, file)
      if file == "theme-mode.conf" then
        vim.schedule(function() vim.cmd.colorscheme("ghostty") end)
      end
    end)
  end,
}
