; Brinq is offered as an "Open with" choice for .msg and .eml files but never
; takes the default handler. Outlook and AMS360 depend on Outlook owning email
; associations, the same way they depended on mailto: (fixed in 1.2.4).

!define BRINQ_EMAIL_PROGID "Brinq.EmailFile"

; 1.2.3-1.2.8 took the default through electron-builder's file associations,
; which used OLD_CLASS as the ProgID and kept the previous one in
; "OLD_CLASS_backup". Updating runs the old uninstaller first, which restores
; that backup. This repairs machines where that did not happen and removes the
; backup value it leaves behind. Only a class whose open verb Brinq wrote is
; treated as Brinq's.
!macro brinqRestoreEmailDefault EXT OLD_CLASS
  Push $R0
  Push $R1
  Push $R2

  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\${OLD_CLASS}\shell\open" ""
  ${If} $R1 == "Open with ${PRODUCT_NAME}"
    ${If} $R0 == "${OLD_CLASS}"
      ReadRegStr $R2 SHELL_CONTEXT "Software\Classes\.${EXT}" "${OLD_CLASS}_backup"
      ${If} $R2 == ""
      ${OrIf} $R2 == "${OLD_CLASS}"
        DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
      ${Else}
        WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "$R2"
      ${EndIf}
    ${EndIf}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${OLD_CLASS}"
  ${EndIf}

  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${If} $R0 != "${OLD_CLASS}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" "${OLD_CLASS}_backup"
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInstall
  !insertmacro brinqRestoreEmailDefault "msg" "Outlook Message"
  !insertmacro brinqRestoreEmailDefault "eml" "Email Message"

  WriteRegStr SHELL_CONTEXT "Software\Classes\${BRINQ_EMAIL_PROGID}" "" "Email message"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BRINQ_EMAIL_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BRINQ_EMAIL_PROGID}\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BRINQ_EMAIL_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.msg\OpenWithProgids" "${BRINQ_EMAIL_PROGID}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.eml\OpenWithProgids" "${BRINQ_EMAIL_PROGID}" ""

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.msg\OpenWithProgids" "${BRINQ_EMAIL_PROGID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.msg\OpenWithProgids"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.eml\OpenWithProgids" "${BRINQ_EMAIL_PROGID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.eml\OpenWithProgids"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${BRINQ_EMAIL_PROGID}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
