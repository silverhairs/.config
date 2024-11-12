-- Dart LSP configuration
require('lspconfig').dartls.setup({})
require('flutter-tools').setup {
    ui = {
        border = "rounded",
        notification_style = 'plugin', -- 'native'
    },
    decoration = {
        statusline = {
            app_version = true,
            device = true,
            project_config = true
        }
    },
    debugger = {
        enabled = true,
        exception_breakpoints = {}, -- List of exceptions where the DAP should stop the execution
        evaluate_to_string_in_debug_views = true,
        register_configurations = function(paths)
            require('dap').configurations.dart = {
                -- put debugger configs here (typically the content of the launch.json file in vscode
            }
        end,
        -- flutter_path = "./.fvm/flutter_sdk/bin", -- Commented because fvm is enabled
        flutter_lookup_cmd = "dirname $(whereis -b flutter | cut -d ' ' -f2)",
        root_patterns = {".git", "pubspec.yaml"},
        fvm = true,
        widget_guides = { enabled = true },
        closing_tags = {
            highlight = "ErrorMsg",
            prefix = ">",
            priority = 10,
            enabled = true,
        },
        dev_log = {
            enabled = true,
            filter = nil, -- optional to filter the logs,
            notify_errors = false,
            open_cmd = "tabedit",
        },
        dev_tools = {
            autostart = false,
            auto_open_browser = false,
        },
        outline = {
            open_cmd = "30vnew", -- command to use to open the outline buffer,
            auto_open = false,
        },
        lsp = {
            color = {
                enabled = false, -- whether or not to highlight color variables at all, only supported on flutter >= 2.10
                background = false, -- highlight the background
                background_color = nil, -- required, when background is transparent (i.e. background_color = { r = 19, g = 17, b = 24},)
                foreground = false, -- highlight the foreground
                virtual_text = true, -- show the highlight using virtual text
                virtual_text_str = "■", -- the virtual text character to highlight
            },
            settings = {
                showTodos = true,
                completeFunctionCalls = true,
                --analysisExcludedFolders = {"<path-to-flutter-sdk-packages>"},
                renameFilesWithClasses = "prompt", -- "always"
                enableSnippets = true,
                updateImportsOnRename = true, -- Whether to update imports and other directives when files are renamed. Required for `FlutterRename` command.
            }
        }
    }
}
