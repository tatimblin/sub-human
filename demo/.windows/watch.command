#!/bin/zsh
printf '\e]0;watch\a\e[3;960;30t\e[8;30;118t'
exec tmux attach -t demo-watch
