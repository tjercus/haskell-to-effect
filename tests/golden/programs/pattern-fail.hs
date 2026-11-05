data Color = Red | Green | Blue

name :: Color -> String
name Red = "red"
name Green = "green"

main :: IO ()
main = do
  putStrLn (name Red)
  putStrLn (name Blue)
