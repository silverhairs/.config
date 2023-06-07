vim.opt.number = true
vim.opt.termguicolors = true
vim.opt.updatetime = 80
vim.opt.colorcolumn = "80"

-- Makes 1 Tab = 4 Spaces
vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true

vim.opt.smartindent = true
vim.opt.wrap = true

-- Disable vim backups, instead let UndoTree get access to long term undos
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.undofile = true
vim.opt.undodir =  os.getenv('HOME') .. '/.vim/undodir'

-- Searching
vim.opt.incsearch = true
vim.opt.hlsearch = true
