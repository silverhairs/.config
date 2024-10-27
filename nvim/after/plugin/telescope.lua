local builtin = require('telescope.builtin')
vim.keymap.set('n', '<leader>ff', builtin.find_files, { desc = 'Telescope find files' })
vim.keymap.set('n', '<leader>/', builtin.live_grep, { desc = 'Telescope live grep' })
vim.keymap.set('n', '<leader>fb', builtin.buffers, { desc = 'Telescope buffers' })
vim.keymap.set('n', '<C-p>', builtin.git_files, {desc = 'Telescope git files'})
vim.keymap.set('n', '<leader>fs', builtin.lsp_document_symbols, {desc ='Telescope document symbols'})
vim.keymap.set('n', '<leader>FS', builtin.lsp_workspace_symbols, {desc = 'Telescope workspace symbols'})
-- vim.keymap.set('n', '<leader>fh', builtin.help_tags, { desc = 'Telescope help tags' }
