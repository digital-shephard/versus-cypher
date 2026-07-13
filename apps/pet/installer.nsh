!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Delete all Versus Cypher data, including the wallet, settings, and local history? Back up the wallet first if you may need it again. This cannot be undone." IDNO keep_versus_data
      RMDir /r "$APPDATA\Versus Cypher"
      RMDir /r "$LOCALAPPDATA\versus-cypher-updater"
      RMDir /r "$LOCALAPPDATA\Versus Cypher-updater"
      keep_versus_data:
    ${endIf}
  ${endIf}
!macroend
