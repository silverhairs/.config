vim.g.mapleader = " "
vim.keymap.set("n", "<leader>E", vim.cmd.Ex)
vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle)
vim.keymap.set("n", "<leader>gs", vim.cmd.Git)

-- Allows you to move selected lines up and down with `W` and `S` keys cause I hate the whole `J` and `K` thing
vim.keymap.set("v", "S", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "W", ":m '<-2<CR>gv=gv")

-- Push yanked data to system's clipboard
vim.keymap.set("n", "<leader>y", "\"+y")
vim.keymap.set("v", "<leader>y", "\"+y")
vim.keymap.set("n", "<leader>Y", "\"+Y")

-- Replace all occurences of the word where the cursor is located
vim.keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])
