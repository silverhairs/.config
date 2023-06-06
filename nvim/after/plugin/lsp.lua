local lsp = require('lsp-zero')
lsp.preset('recommended')
lsp.ensure_installed({
	'tsserver',
	'eslint',
	'lua_ls',
	'rust_analyzer',
	'gopls',
})

local cmp = require('cmp')
local cmp_select = {behavior = cmp.SelectBehavior.Select}
local cmp_mappings = lsp.defaults.cmp_mappings({
	['<C-p>'] = cmp.mapping.select_prev_item(cmp_select),
	['<C-n>'] = cmp.mapping.select_next_item(cmp_select),	
	['<C-y>'] = cmp.mapping.confirm({confirm = true}),
	['<C-Space>'] = cmp.mapping.complete(),
})

lsp.set_sign_icons({
	error = '✘',
	warn = '▲',
	hint = '⚑',
	info = '»'
})

lsp.setup_nvim_cmp({mapping= cmp_mappings })
lsp.on_attach(function(client, buffr)
	local opts = {buffer = buffr, remap = false}
	-- Overriding some keymaps when there is a buffer
	vim.keymap.set('n', 'gd', function() vim.lsp.buf.definition() end, opts)
	vim.keymap.set('n', 'K', function() vim.lsp.buf.hover() end, opts)
	vim.keymap.set('n', '<leader>vws', function() vim.lsp.buf.workspace_symbol() end, opts)
	vim.keymap.set('n', '<leader>vd', function() vim.diagnostic.open_float() end, opts)
	vim.keymap.set('n', '<leader>vca', function() vim.lsp.buf.code_action() end , otps)
	vim.keymap.set('n', '<leader>vrr', function() vim.lsp.buf.references() end , otps)
	vim.keymap.set('n', '[d', function() vim.diagnostic.goto_next() end, otps)
	vim.keymap.set('n', ']d', function() vim.diagnostic.goto_prev() end, otps)
	vim.keymap.set('n', '<leader>vrn', function() vim.lsp.buf.rename() end, otps)
	vim.keymap.set('i', '<C-h>', function() vim.lsp.buf.signature_help() end, otps)
end)

lsp.setup()
