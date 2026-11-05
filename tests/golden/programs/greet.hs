module Main where

data Shape = Circle Int | Rect Int Int

area :: Shape -> Int
area (Circle r) = 3 * r * r
area (Rect w h) = w * h

main :: IO ()
main = do
  name <- getLine
  putStrLn ("Hello, " ++ name)
  print (area (Rect 2 3))
