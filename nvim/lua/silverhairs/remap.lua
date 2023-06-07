local keymap = vim.keymap

vim.g.mapleader = " "
keymap.set("n", "<leader>E", vim.cmd.Ex)
keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle)
keymap.set("n", "<leader>gs", vim.cmd.Git)

-- Allows you to move selected lines up and down with `W` and `S` keys cause I hate the whole `J` and `K` thing
keymap.set("v", "S", ":m '>+1<CR>gv=gv")
keymap.set("v", "W", ":m '<-2<CR>gv=gv")

-- Push yanked data to system's clipboard
keymap.set("n", "<leader>y", "\"+y")
keymap.set("v", "<leader>y", "\"+y")
keymap.set("n", "<leader>Y", "\"+Y")

-- Replace all occurences of the word where the cursor is located
keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])
