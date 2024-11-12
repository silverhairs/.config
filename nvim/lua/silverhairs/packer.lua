vim.cmd [[packadd packer.nvim]]

return require('packer').startup(function(use)
	-- Packer can manage itself
	use 'wbthomason/packer.nvim'
	use {
		'nvim-telescope/telescope.nvim', tag='0.1.8',
		requires = { {'nvim-lua/plenary.nvim'} }

	}
    use {'nvim-telescope/telescope-symbols.nvim'}
	use { "catppuccin/nvim", as = "catppuccin" }
	use {'freddiehaddad/feline.nvim', tag="v1.6.4"}
	use('nvim-treesitter/nvim-treesitter',{run = ':TSUpdate'})
	use {'tpope/vim-fugitive'}
	use({'VonHeikemen/lsp-zero.nvim', branch = 'v4.x'})
	use({'neovim/nvim-lspconfig'})
	use({'hrsh7th/nvim-cmp'})
	use({'hrsh7th/cmp-nvim-lsp'})
    use{
        'nvim-flutter/flutter-tools.nvim',
        requires = {
            'nvim-lua/plenary.nvim',
            'stevearc/dressing.nvim',
        }
    }
    use({'j-hui/fidget.nvim', tag='v1.0.0'})
	use {
		"utilyre/barbecue.nvim", tag="*",
		requires = {
			"SmiteshP/nvim-navic",
			"nvim-tree/nvim-web-devicons",
		},
		after = "nvim-web-devicons",
		config = function()
			require("barbecue").setup()
		end,
	}
end)
