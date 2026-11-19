# Izinkan koneksi ws:// (tanpa TLS) ke alamat IP lokal
p = 'android/app/src/main/AndroidManifest.xml'
s = open(p, encoding='utf-8').read()
if 'usesCleartextTraffic' not in s:
    s = s.replace('<application', '<application android:usesCleartextTraffic="true"', 1)
open(p, 'w', encoding='utf-8').write(s)
print('manifest ok')
