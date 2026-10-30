# assets

- `common-passwords.txt.gz`: las 100 000 contraseñas más usadas según el NCSC del Reino Unido, de
  [SecLists](https://github.com/danielmiessler/SecLists) (`Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`,
  licencia MIT, © 2018 Daniel Miessler). En minúsculas y sin repetidos. Se rehace con:

  ```sh
  curl -sSfL https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt \
    | tr -d '\r' | tr 'A-Z' 'a-z' | awk 'length>0' | LC_ALL=C sort -u | gzip -9n > common-passwords.txt.gz
  ```

  La usa `src/identity/passwords.ts` para rechazar contraseñas nuevas comunes.
