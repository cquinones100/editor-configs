# lazygit
ln -sf ~/editor-configs/lazygit/config.yml ~/Library/Application\ Support/lazygit/config.yml

# vscode
ln -sf ~/editor-configs/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -sf ~/editor-configs/vscode/tasks.json ~/Library/Application\ Support/Code/User/tasks.json
ln -sf ~/editor-configs/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
ln -sf ~/editor-configs/vscode/snippets ~/Library/Application\ Support/Code/User/snippets

# neovim
ln -sf ~/editor-configs/nvim/init.lua ~/.config/nvim/init.lua

# git
ln -sf ~/editor-configs/git/.gitconfig ~/.gitconfig

# claude
ln -sf ~/editor-configs/claude/CLAUDE.md ~/.claude/CLAUDE.md
ln -sf ~/editor-configs/claude/settings.json ~/.claude/settings.json
ln -sf ~/editor-configs/claude/statusline-command.sh ~/.claude/statusline-command.sh
mkdir -p ~/.claude/hooks
for hook in ~/editor-configs/claude/hooks/*; do
  ln -sf "$hook" ~/.claude/hooks/
done

# iterm
ln -sf ~/editor-configs/iterm/com.googlecode.iterm2.plist ~/Library/Preferences/com.googlecode.iterm2.plist

# karabiner
ln -s ~/editor-configs/karabiner/settings.json ~/.config/karabiner
