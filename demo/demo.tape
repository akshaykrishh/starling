# The README demo. Record from the repo root after `npm run build`:  vhs demo/demo.tape
Output demo/starling.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 16
Set Width 1480
Set Height 440
Set Padding 24
Set TypingSpeed 45ms
Set Theme { "name": "starling", "background": "#0c0d11", "foreground": "#e9ecf2", "cursor": "#f5c542", "selection": "#2a2d37", "black": "#0a0c0f", "red": "#ff7a85", "green": "#86e08f", "yellow": "#f5c542", "blue": "#7aa2ff", "magenta": "#9b86ff", "cyan": "#36b3a6", "white": "#e9ecf2", "brightBlack": "#5c606c", "brightRed": "#ff9aa2", "brightGreen": "#a6f0ad", "brightYellow": "#ffd970", "brightBlue": "#9cbaff", "brightMagenta": "#b8a8ff", "brightCyan": "#5fd0c3", "brightWhite": "#ffffff" }

Hide
Type "export PS1='\[\e[38;2;245;197;66m\]$\[\e[0m\] ' && source demo/setup.sh"
Enter
Sleep 2s
Show

Type "starling ls"
Sleep 400ms
Enter
Sleep 3s

Type "starling doctor"
Sleep 400ms
Enter
Sleep 3.5s

Type "starling doctor --fix"
Sleep 400ms
Enter
Sleep 2s

Type "clear && starling gc"
Sleep 400ms
Enter
Sleep 4.5s

Type "clear && starling memory lint"
Sleep 400ms
Enter
Sleep 4s
