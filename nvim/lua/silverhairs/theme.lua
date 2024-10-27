
require("catppuccin").setup({
    flavour = "auto", -- latte, frappe, macchiato, mocha
    background = { -- :h background
        light = "latte",
        dark = "mocha",
    },
    transparent_background = false, -- disables setting the background color.
    show_end_of_buffer = false, -- shows the '~' characters after the end of buffers
    term_colors = false, -- sets terminal colors (e.g. `g:terminal_color_0`)
    dim_inactive = {
        enabled = false, -- dims the background color of inactive window
        shade = "dark",
        percentage = 0.15, -- percentage of the shade to apply to the inactive window
    },
    no_italic = false, -- Force no italic
    no_bold = false, -- Force no bold
    no_underline = false, -- Force no underline
    styles = { -- Handles the styles of general hi groups (see `:h highlight-args`):
        comments = { "italic" }, -- Change the style of comments
        conditionals = { "italic" },
        loops = {},
        functions = {},
        keywords = {},
        strings = {},
        variables = {},
        numbers = {},
        booleans = {},
        properties = {},
        types = {},
        operators = {},
        -- miscs = {}, -- Uncomment to turn off hard-coded styles
    },
    color_overrides = {},
    custom_highlights = {},
    default_integrations = true,
    integrations = {
        fidget = true,
        cmp = true,
        gitsigns = true,
        nvimtree = true,
        treesitter = true,
        notify = false,
        mini = {
            enabled = true,
            indentscope_color = "",
        },
        -- For more plugins integrations please scroll down (https://github.com/catppuccin/nvim#integrations)
    },
})
vim.cmd.colorscheme "catppuccin"

local ctp_feline = require("catppuccin.groups.integrations.feline")
local clrs = require("catppuccin.palettes").get_palette()

ctp_feline.setup({
    assets = {
        left_separator = "",
        right_separator = "",
        mode_icon = "",
        dir = "󰉖",
        file = "󰈙",
        lsp = {
            server = "󰅡",
            error = "",
            warning = "",
            info = "",
            hint = "",
        },
        git = {
            branch = "",
            added = "",
            changed = "",
            removed = "",
        },
    },
    sett = {
        diffs = clrs.mauve,
        extras = clrs.overlay1,
        curr_file = clrs.maroon,
        curr_dir = clrs.flamingo,
        show_modified = false, -- show if the file has been modified
        show_lazy_updates = false -- show the count of updatable plugins from lazy.nvim
        -- need to set checker.enabled = true in lazy.nvim first
        -- the icon is set in ui.icons.plugin in lazy.nvim
    },
    mode_colors = {
        ["n"] = { "NORMAL", clrs.lavender },
        ["no"] = { "N-PENDING", clrs.lavender },
        ["i"] = { "INSERT", clrs.green },
        ["ic"] = { "INSERT", clrs.green },
        ["t"] = { "TERMINAL", clrs.green },
        ["v"] = { "VISUAL", clrs.flamingo },
        ["V"] = { "V-LINE", clrs.flamingo },
        ["�"] = { "V-BLOCK", clrs.flamingo },
        ["R"] = { "REPLACE", clrs.maroon },
        ["Rv"] = { "V-REPLACE", clrs.maroon },
        ["s"] = { "SELECT", clrs.maroon },
        ["S"] = { "S-LINE", clrs.maroon },
        ["␓"] = { "S-BLOCK", clrs.maroon },
        ["c"] = { "COMMAND", clrs.peach },
        ["cv"] = { "COMMAND", clrs.peach },
        ["ce"] = { "COMMAND", clrs.peach },
        ["r"] = { "PROMPT", clrs.teal },
        ["rm"] = { "MORE", clrs.teal },
        ["r?"] = { "CONFIRM", clrs.mauve },
        ["!"] = { "SHELL", clrs.green },
    },
    view = {
        lsp = {
            progress = true, -- if true the status bar will display an lsp progress indicator
            name = false, -- if true the status bar will display the lsp servers name, otherwise it will display the text "Lsp"
            exclude_lsp_names = {}, -- lsp server names that should not be displayed when name is set to true
            separator = "|", -- the separator used when there are multiple lsp servers
        },
    }

})


require("feline").setup({
    components = ctp_feline.get(),
})

vim.api.nvim_create_autocmd("ColorScheme", {
    pattern = "*",
    callback = function()
        package.loaded["feline"] = nil
        package.loaded["catppuccin.groups.integrations.feline"] = nil
        require("feline").setup {
            components = require("catppuccin.groups.integrations.feline").get(),
        }
    end,
})

require('fidget').setup({
    progress = {
        poll_rate = 0,                -- How and when to poll for progress messages
        suppress_on_insert = false,   -- Suppress new messages while in insert mode
        ignore_done_already = false,  -- Ignore new tasks that are already complete
        ignore_empty_message = false, -- Ignore new tasks that don't contain a message
        clear_on_detach =             -- Clear notification group when LSP server detaches
        function(client_id)
            local client = vim.lsp.get_client_by_id(client_id)
            return client and client.name or nil
        end,
        notification_group =          -- How to get a progress message's notification group key
        function(msg) return msg.lsp_client.name end,
        ignore = {},                  -- List of LSP servers to ignore

        -- Options related to how LSP progress messages are displayed as notifications
        display = {
            render_limit = 16,          -- How many LSP messages to show at once
            done_ttl = 3,               -- How long a message should persist after completion
            done_icon = "✔",            -- Icon shown when all LSP progress tasks are complete
            done_style = "Constant",    -- Highlight group for completed LSP tasks
            progress_ttl = math.huge,   -- How long a message should persist when in progress
            progress_icon =             -- Icon shown when LSP progress tasks are in progress
            { pattern = "dots", period = 1 },
            progress_style =            -- Highlight group for in-progress LSP tasks
            "WarningMsg",
            group_style = "Title",      -- Highlight group for group name (LSP server name)
            icon_style = "Question",    -- Highlight group for group icons
            priority = 30,              -- Ordering priority for LSP notification group
            skip_history = true,        -- Whether progress notifications should be omitted from history
            format_message =            -- How to format a progress message
            require("fidget.progress.display").default_format_message,
            format_annote =             -- How to format a progress annotation
            function(msg) return msg.title end,
            format_group_name =         -- How to format a progress notification group's name
            function(group) return tostring(group) end,
            overrides = {               -- Override options from the default notification config
                rust_analyzer = { name = "rust-analyzer" },
            },
        },

        -- Options related to Neovim's built-in LSP client
        lsp = {
            progress_ringbuf_size = 0,  -- Configure the nvim's LSP progress ring buffer size
            log_handler = false,        -- Log `$/progress` handler invocations (for debugging)
        },
    },

    -- Options related to notification subsystem
    notification = {
        poll_rate = 10,               -- How frequently to update and render notifications
        filter = vim.log.levels.INFO, -- Minimum notifications level
        history_size = 128,           -- Number of removed messages to retain in history
        override_vim_notify = false,  -- Automatically override vim.notify() with Fidget
        configs =                     -- How to configure notification groups when instantiated
        { default = require("fidget.notification").default_config },
        redirect =                    -- Conditionally redirect notifications to another backend
        function(msg, level, opts)
            if opts and opts.on_open then
                return require("fidget.integration.nvim-notify").delegate(msg, level, opts)
            end
        end,

        -- Options related to how notifications are rendered as text
        view = {
            stack_upwards = true,       -- Display notification items from bottom to top
            icon_separator = " ",       -- Separator between group name and icon
            group_separator = "---",    -- Separator between notification groups
            group_separator_hl =        -- Highlight group used for group separator
            "Comment",
            render_message =            -- How to render notification messages
            function(msg, cnt)
                return cnt == 1 and msg or string.format("(%dx) %s", cnt, msg)
            end,
        },

        -- Options related to the notification window and buffer
        window = {
            normal_hl = "Comment",      -- Base highlight group in the notification window
            winblend = 100,             -- Background color opacity in the notification window
            border = "none",            -- Border around the notification window
            zindex = 45,                -- Stacking priority of the notification window
            max_width = 0,              -- Maximum width of the notification window
            max_height = 0,             -- Maximum height of the notification window
            x_padding = 1,              -- Padding from right edge of window boundary
            y_padding = 0,              -- Padding from bottom edge of window boundary
            align = "bottom",           -- How to align the notification window
            relative = "editor",        -- What the notification window position is relative to
        },
    },

    -- Options related to integrating with other plugins
    integration = {
        ["nvim-tree"] = {
            enable = true,              -- Integrate with nvim-tree/nvim-tree.lua (if installed)
        },
        ["xcodebuild-nvim"] = {
            enable = true,              -- Integrate with wojciech-kulik/xcodebuild.nvim (if installed)
        },
    },

    -- Options related to logging
    logger = {
        level = vim.log.levels.WARN,  -- Minimum logging level
        max_size = 10000,             -- Maximum log file size, in KB
        float_precision = 0.01,       -- Limit the number of decimals displayed for floats
        path =                        -- Where Fidget writes its logs to
        string.format("%s/fidget.nvim.log", vim.fn.stdpath("cache")),
    },
})
